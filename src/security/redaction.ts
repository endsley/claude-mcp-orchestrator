import type { JsonValue } from '../types/json.js';

/**
 * Secret redaction.
 *
 * Applied to everything that can leave the process: logs, MCP tool results,
 * session summaries, error payloads and doctor output. The rule of thumb is
 * that this runs on the way OUT, not on the way in, so a value that is only
 * ever held in memory still gets scrubbed the moment anyone tries to render it.
 */

export const REDACTED = '[redacted]';

/**
 * Words that mark a key as holding a secret.
 *
 * Matched against WORDS, not substrings. A naive substring match is actively
 * harmful: "token" appears in `estimatedTokens`, `maxTokens` and `tokenCount`,
 * and "auth" appears in `author` and `authMode`. Silently replacing those with
 * "[redacted]" corrupts real data and destroys diagnostics, which is how this
 * bug was found — the context token budget was being reported as a string.
 *
 * Key matching is a convenience, not the real defence: {@link redactText} still
 * scrubs anything that LOOKS like a secret regardless of the key it sits under.
 */
const SENSITIVE_WORDS = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'secrets',
  'token',
  'tokens',
  'credential',
  'credentials',
  // The abbreviation is as common as the word in logs and config.
  'creds',
  'apikey',
  'authorization',
  'cookie',
  'cookies',
  'signature',
  'otp',
  'mfa',
  'pin',
  'salt',
  'bearer',
  'privatekey',
  'accesskey',
  'clientsecret',
]);

/**
 * Words that, alongside "token"/"tokens"/"key", indicate a COUNT or a limit
 * rather than a credential.
 */
const QUANTITY_WORDS = new Set([
  'max',
  'min',
  'estimated',
  'budget',
  'total',
  'used',
  'remaining',
  'count',
  'limit',
  'size',
  'length',
  'input',
  'output',
  'num',
  'number',
  'thinking',
  'cache',
  'per',
]);

/**
 * Compound keys that carry METADATA about a credential, not the credential.
 *
 * isSensitiveKey works on words, so every one of these contains "token",
 * "secret" or "authorization" and was redacted unconditionally -- destroying
 * exactly the fields an operator needs while debugging an OAuth flow.
 * `token_type: "Bearer"` is a type label. `tokenEndpoint` is a published URL
 * from a discovery document. `secretName` is the pointer that says WHICH
 * secret was involved, and erasing it removes the only identifying detail
 * while protecting nothing.
 *
 * Matched on the joined word form, so token_type, tokenType and TOKEN_TYPE are
 * all the same entry.
 */
const CREDENTIAL_METADATA_KEYS = new Set([
  'tokentype',
  'tokenendpoint',
  'tokenurl',
  'tokenpath',
  'tokenname',
  'secretname',
  'secretarn',
  'secretid',
  'secretkeyref',
  'authorizationendpoint',
  'authorizationurl',
  'authorizationstatus',
  'authorizationcode',
]);

/** Words that turn a bare "key" into a credential. */
const KEY_QUALIFIERS = new Set(['api', 'private', 'secret', 'access', 'ssh', 'signing', 'encryption', 'session']);

/** Split camelCase / snake_case / kebab-case into lowercase words. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
}

/**
 * High-signal secret shapes. Ordered most specific first so that, e.g., an
 * Anthropic key is reported as such rather than as a generic long string.
 *
 * Each pattern must be anchored enough that it cannot match ordinary prose —
 * a false positive here silently destroys useful diagnostics.
 */
const VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  // OpenAI also issues sk-proj-, sk-svcacct-, sk-admin- and sk-None- keys whose
  // bodies contain "-" and "_". A body of [A-Za-z0-9]{32,} stopped dead at the
  // dash in "sk-proj-", so every modern project key passed through untouched.
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{32,}/g },
  // gh?_ is the classic form; fine-grained PATs are github_pat_ with a far
  // longer body and underscores inside it.
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  // xoxd- is the browser cookie token and xapp- the app-level token; both are
  // as sensitive as xoxb-, and neither was covered.
  { name: 'slack-token', re: /\b(?:xox[abdeprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Three segments is a JWS; a JWE has five. Matching only the first three left
  // the ciphertext and the authentication tag in the log.
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*/g },
  { name: 'tailscale-key', re: /\btskey-[A-Za-z0-9-]{10,}/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Credentials in a URL's userinfo. These reach logs constantly, because the
  // URL is the first thing anyone prints when a request fails.
  { name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+):[^\s/@]+@/gi },
  // `Authorization: Bearer <token>` in any casing, including inside JSON dumps
  // -- which is why the quote is part of the prefix group. Without it the
  // pattern stopped at the `"` in {"authorization":"Bearer ..."} and matched
  // nothing, despite this comment having claimed JSON support all along.
  // Any auth scheme, not just Bearer. `Basic <base64(user:password)>` is a
  // password in light disguise, and pinning the scheme to "bearer" meant the
  // optional group failed, the {12,} body then had to match "Basic" itself, and
  // the whole pattern missed -- leaking the credential in full. The scheme
  // allows digits because OAuth2 is a real one.
  //
  // The scheme is captured separately because its PRESENCE is the evidence.
  // "Authorization: <scheme> <token>" is a credential whatever the token looks
  // like, so the token is redacted unconditionally there. With no scheme,
  // anything after the colon is as likely to be prose, and a previous version
  // of this pattern ate "authorization: mode=api-key",
  // "authorization: successful-login-completed" and
  // {"authorization":"pending-approval"} -- so the no-scheme case has to look
  // credential-shaped. See looksLikeCredential.
  //
  // Still accepted over-reach: "authorization: Server authentication failed"
  // redacts, because "Server" parses as a scheme and "Scheme word" is genuinely
  // ambiguous. Safety wins where a scheme is present.
  {
    name: 'auth-header',
    re: /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)((?:[A-Za-z][A-Za-z0-9-]*\s+)?)([A-Za-z0-9._~+/=-]{12,})/gi,
  },
];

/**
 * Words that can only ever name a credential, even standing alone.
 *
 * Needed because the assignment pattern is case-insensitive: a bare lowercase
 * "token: expired" or "signature: v2" in prose is a log line, not a leak, but
 * "password=hunter2" is a leak whether or not the key is compound.
 */
const STANDALONE_SECRET_WORDS = new Set(['password', 'passwd', 'passphrase', 'secret', 'apikey', 'credential', 'credentials']);

/**
 * Scrub `key=value` / `"key": "value"` for ANY key, with isSensitiveKey() -- not
 * a regex alternation -- deciding whether the value is a secret. The
 * alternation this replaces was a third copy of the policy and had already
 * drifted from the other two: ENCRYPTION_KEY, SIGNING_KEY and SESSION_COOKIE
 * were all sensitive to isSensitiveKey and all invisible in free text.
 *
 * This is a manual scan rather than a `String.replace` because a global regex
 * CONSUMES what it matches, and a harmless pair swallowing a secret is worse
 * than no pattern at all:
 *
 *   payload={access_token=<secret>}   matched key "payload", value
 *                                     "{access_token=<secret>", found it
 *                                     harmless, and consumed the secret.
 *   https://h/v1?access_token=<s>     matched key "https", value "//h/v1…".
 *
 * On a harmless pair the cursor is therefore rewound to just after the
 * separator, so a nested assignment is still examined. lastIndex strictly
 * increases (the key is at least one character), so the loop always terminates.
 */
/**
 * Whether the text at `from`, after any whitespace, is a redaction placeholder.
 *
 * Written as an index scan rather than `input.slice(from)` against a regex,
 * because the slice runs once PER MATCH and a log line is mostly matches. That
 * measured superlinearly at 256KB (the MCP body limit) -- the same shape as the
 * unbounded-input mistake this repo has already paid for once.
 */
function placeholderFollows(text: string, from: number): boolean {
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') break;
    index += 1;
  }
  return text.startsWith(REDACTED, index);
}

function redactAssignments(input: string): string {
  // The value alternation takes a QUOTED run first. Matching only to the next
  // whitespace leaked the tail of every quoted passphrase:
  // password="correct horse battery staple" kept three of its four words.
  const re = /\b([A-Za-z][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]"'?&#]+)/g;
  let out = '';
  let cursor = 0;
  let match: RegExpExecArray | null = re.exec(input);
  while (match !== null) {
    const [whole, key, sep, raw] = match as unknown as [string, string, string, string];
    const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : '';
    const value = quote === '' ? raw : raw.slice(1, -1);
    // An earlier, more specific pattern may already have handled this text --
    // either the value IS the placeholder, or the placeholder sits just after
    // it, as in "authorization: Bearer [redacted]" where the scheme is
    // deliberately kept. Redacting again would eat the part worth keeping.
    const handled =
      value.startsWith('[redacted') || placeholderFollows(input, match.index + whole.length);
    if (!handled && assignmentIsSecret(key, value)) {
      out += input.slice(cursor, match.index) + key + sep + quote + REDACTED + quote;
      cursor = match.index + whole.length;
      re.lastIndex = cursor;
    } else {
      // Rewind past the separator only, never past the value: a harmless pair
      // that consumes its value can swallow a nested secret.
      re.lastIndex = match.index + key.length + sep.length;
    }
    match = re.exec(input);
  }
  return out + input.slice(cursor);
}

/**
 * Whether a string is shaped like an opaque credential rather than prose.
 *
 * Every real encoding of a secret -- base64, base64url, hex, a vendor id --
 * mixes case, digits or punctuation. English does not. This is only ever used
 * to break a tie where the surrounding syntax is ambiguous; a value with a
 * known prefix or a sensitive compound key never needs it.
 */
function looksLikeCredential(value: string): boolean {
  // "successful-login-completed", "pending-approval", "expired".
  if (/^[a-z-]+$/.test(value)) return false;
  // "=" is base64 padding and belongs at the END. In the middle it is a nested
  // assignment such as "mode=api-key".
  if (/=[^=]/.test(value)) return false;
  return true;
}

/**
 * Whether a value NAMES a secret rather than being one.
 *
 * This layer runs over every tool result, and reading source is the main thing
 * this product does -- so `const apiKey = process.env.MEM0_API_KEY;` arriving
 * at the model as `const apiKey = [redacted];` costs it the one fact the line
 * carried. Same for `this.token = options.token`, `password = getPassword()`
 * and `apiKey = undefined`. None of them contains a credential; all of them
 * were scrubbed.
 *
 * Deliberately narrow. Only shapes no credential format uses:
 *
 *   a dotted path      process.env.MEM0_API_KEY, req.headers.authorization
 *   a call             getPassword(), readSecret()
 *   a language literal null, undefined, true, false, "" and ''
 *   a placeholder      <paste yours>, $(cat token.txt)
 *
 * A BARE single identifier is NOT in the list, even though `token = someVar`
 * is just as harmless, because `api_key=abc123def456` has exactly that shape
 * and is a real leak. Missing a harmless case costs a line of diagnostics;
 * missing that one costs a credential, so the residue stays on the safe side.
 */
function namesRatherThanHolds(value: string): boolean {
  if (value === 'null' || value === 'undefined' || value === 'true' || value === 'false') return true;
  if (value === '""' || value === "''" || value === '') return true;
  // A placeholder or a shell substitution: both are instructions to the
  // reader, not values.
  if (value.startsWith('<') || value.startsWith('$(') || value.startsWith('${')) return true;
  // Dotted path or call. The dot or the parentheses are what make it safe to
  // recognise; a single identifier would not be.
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\s*\))?$/.test(value) ||
    /^[A-Za-z_$][\w$]*\(\s*\)$/.test(value);
}

/** Whether `key = value` in free text should have its value scrubbed. */
function assignmentIsSecret(key: string, value: string): boolean {
  if (!isSensitiveKey(key)) return false;
  if (namesRatherThanHolds(value)) return false;
  const words = keyWords(key);
  if (words.length > 1) return true;
  if (key === key.toUpperCase() && /[A-Z]/.test(key)) return true;
  if (STANDALONE_SECRET_WORDS.has(words[0] ?? '')) return true;
  // A bare lowercase "token"/"bearer"/"signature" is usually a log label, which
  // is why it is excluded above -- but "token=<40 hex chars>" is a secret, and
  // the module's own comment claimed unshaped secrets were caught by their key.
  // Break the tie on the value: prose is short and alphabetic.
  return value.length >= 16 && looksLikeCredential(value) && !/^[A-Za-z]+$/.test(value);
}

/**
 * Shapes that CANNOT be matched, recorded so nobody wastes time adding them.
 *
 * An AWS secret access key, a Stripe restricted key body, a raw session token
 * -- anything that is 40 characters of base64 with no prefix -- is
 * indistinguishable from a SHA hash, a git object id, a base64 thumbnail or a
 * content digest. Matching that shape would redact half of every useful log
 * line. Those values are caught by their KEY instead (isSensitiveKey, or the
 * sensitive-assignment pattern above), which is why key coverage matters more
 * than pattern coverage.
 */

/** Redact secrets from a free-text string. */
export function redactText(input: string): string {
  if (input === '') return input;
  let out = input;
  for (const { re, name } of VALUE_PATTERNS) {
    // Patterns with capture groups keep the harmless prefix so the log still
    // says WHICH setting was scrubbed.
    if (name === 'auth-header') {
      out = out.replace(re, (whole: string, prefix: string, scheme: string, token: string) => {
        // A scheme means a credential whatever the token looks like. Without
        // one, the text after the colon has to look like a credential.
        if (scheme !== '' || looksLikeCredential(token)) return `${prefix}${scheme}${REDACTED}`;
        return whole;
      });
    } else if (name === 'url-credentials') {
      out = out.replace(re, (_m, prefix: string) => `${prefix}:${REDACTED}@`);
    } else {
      out = out.replace(re, REDACTED);
    }
  }
  // Last, so the shape patterns have already run and their placeholders are
  // recognisable to the scanner.
  return redactAssignments(out);
}

/** True when an object key's NAME implies its value is a secret. */
export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  const joined = words.join('');

  // Metadata about a credential is not a credential.
  if (CREDENTIAL_METADATA_KEYS.has(joined)) return false;

  // Joined forms like apiKey -> ["api","key"], or api_key -> ["api","key"].
  if (SENSITIVE_WORDS.has(joined)) return true;

  const hasQuantity = words.some((word) => QUANTITY_WORDS.has(word));

  for (const word of words) {
    if (!SENSITIVE_WORDS.has(word)) continue;
    // "maxTokens" / "estimatedTokens" / "tokenCount" are numbers, not secrets.
    if ((word === 'token' || word === 'tokens') && hasQuantity) continue;
    return true;
  }

  // A bare "key" is only a secret when qualified: apiKey yes, keyCount no.
  if (words.includes('key') || words.includes('keys')) {
    if (words.some((word) => KEY_QUALIFIERS.has(word)) && !hasQuantity) return true;
  }

  // "auth" alone is ambiguous (authMode, author); only the full word counts.
  if (words.includes('auth') && words.some((word) => ['token', 'header', 'secret', 'value'].includes(word))) {
    return true;
  }

  return false;
}

const MAX_REDACT_DEPTH = 12;

/** The shared prototype of every typed array; not exposed as a global. */
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array) as new () => object;

/**
 * Deep-redact an arbitrary value: sensitive keys lose their values entirely,
 * and every remaining string is run through {@link redactText}.
 *
 * Cycles are replaced with "[circular]" rather than throwing, because this runs
 * inside error paths where throwing again would lose the original failure.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;

  if (depth >= MAX_REDACT_DEPTH) return '[truncated]';

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (value instanceof Error) {
      // name/message/stack alone threw away the most useful field a Node error
      // carries. An ECONNREFUSED is diagnosed by its `code`, not by the words
      // "connect failed", and `cause` is where fetch and undici put the real
      // reason. All of them are non-enumerable or otherwise skipped by
      // JSON.stringify, so dropping them here meant they were simply gone.
      const out: Record<string, JsonValue> = {
        name: value.name,
        message: redactText(value.message),
        ...(value.stack ? { stack: redactText(value.stack) } : {}),
      };
      for (const field of ['code', 'errno', 'syscall', 'path', 'port', 'address'] as const) {
        const detail = (value as unknown as Record<string, unknown>)[field];
        if (detail !== undefined) out[field] = redactValue(detail, depth + 1, seen);
      }
      if (value.cause !== undefined) out['cause'] = redactValue(value.cause, depth + 1, seen);
      const aggregate = (value as unknown as { errors?: unknown }).errors;
      if (Array.isArray(aggregate)) out['errors'] = redactValue(aggregate, depth + 1, seen);
      return out;
    }
    if (value instanceof Date) {
      // An invalid Date throws RangeError from toISOString, and this function
      // is called BY error handlers -- the one place a throw destroys the
      // failure the caller was trying to report. Recognising a Date and
      // reading one are, again, two different problems.
      const time = value.getTime();
      return Number.isFinite(time) ? value.toISOString() : '[invalid Date]';
    }
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1, seen));
    }

    // Binary data must NEVER fall through to Object.entries. A Buffer holding a
    // secret becomes {"0":115,"1":107,…} -- byte values that reconstruct the
    // credential exactly, having never been near redactText. Report the shape
    // and the size, which is all a log line can usefully say about bytes.
    if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
    // instanceof, not ArrayBuffer.isView. isView tests an internal slot, which a
    // Proxy does not have, so ArrayBuffer.isView(new Proxy(buffer, {})) is false
    // and a proxy-wrapped secret byte-dumped anyway. instanceof walks the
    // prototype chain, which a Proxy DOES forward, and it also covers subclasses.
    if (value instanceof TYPED_ARRAY || value instanceof DataView) {
      // || not ??: an anonymous subclass has a name of '', not undefined.
      const kind = (value as { constructor?: { name?: string } }).constructor?.name || 'TypedArray';
      // Reading .byteLength needs the same internal slot ArrayBuffer.isView
      // needed, so on a Proxy the getter THROWS even though instanceof matched.
      // Identifying an exotic object and reading it are two different problems;
      // fixing only the first turned a byte-dump into an exception, inside a
      // function whose contract is never to throw on an error path.
      try {
        return `[${kind} ${(value as { byteLength: number }).byteLength} bytes]`;
      } catch {
        return `[${kind} of unreadable length]`;
      }
    }
    // Map and Set have no own enumerable properties, so Object.entries returned
    // "{}" and the contents vanished. That loses diagnostics rather than
    // leaking, but a redactor that silently eats data gets worked around.
    if (value instanceof Map || value instanceof Set) {
      // A Proxy passes instanceof but throws TypeError from .entries(), because
      // the method needs an internal slot the proxy lacks. This function runs on
      // error paths, where throwing again destroys the original failure, so an
      // unreadable collection degrades to a label instead.
      try {
        if (value instanceof Map) {
          const out: Record<string, JsonValue> = {};
          for (const [key, item] of value.entries()) {
            // The KEY can be the secret: new Map([[token, 'ok']]) would
            // otherwise emit the token as a property name.
            const name = redactText(typeof key === 'string' ? key : String(key));
            out[name] = isSensitiveKey(name) ? REDACTED : redactValue(item, depth + 1, seen);
          }
          return out;
        }
        return [...value.values()].map((item) => redactValue(item, depth + 1, seen));
      } catch {
        return `[unreadable ${value.constructor?.name ?? 'collection'}]`;
      }
    }

    // Object.keys rather than Object.entries, and the read is guarded: entries
    // INVOKES getters, so one property whose getter throws took the whole
    // redaction down -- and this function is called by error handlers, where
    // throwing again loses the failure the caller was trying to report.
    const out: Record<string, JsonValue> = {};
    // Object.keys can itself throw: a Proxy may trap ownKeys. Enumerating and
    // reading are two more places the same lesson applies.
    let keys: string[];
    try {
      keys = Object.keys(value as Record<string, unknown>);
    } catch {
      return `[unreadable ${(value as { constructor?: { name?: string } }).constructor?.name || 'object'}]`;
    }
    for (const key of keys) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      let item: unknown;
      try {
        item = (value as Record<string, unknown>)[key];
      } catch {
        out[key] = '[unreadable]';
        continue;
      }
      out[key] = redactValue(item, depth + 1, seen);
    }
    return out;
  }

  return String(value);
}

/**
 * Redact an environment-variable map. Unlike {@link redactValue} this keeps the
 * key names but drops every suspicious value, and never echoes a value merely
 * because its name looked innocuous.
 *
 * Nothing calls this -- not src/, and not scripts/doctor.ts either, which
 * imports only redactText. An earlier version of this comment implied the
 * doctor used it; it does not. Kept because it is the only correct way to dump
 * an environment and it is covered by tests, but it is unused code and should
 * be read as such.
 */
export function redactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    out[key] = isSensitiveKey(key) ? REDACTED : redactText(value);
  }
  return out;
}
