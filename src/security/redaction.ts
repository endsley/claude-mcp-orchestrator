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
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'tailscale-key', re: /\btskey-[A-Za-z0-9-]{10,}/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Credentials in a URL's userinfo. These reach logs constantly, because the
  // URL is the first thing anyone prints when a request fails.
  { name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+):[^\s/@]+@/gi },
  // `Authorization: Bearer <token>` in any casing, including inside JSON dumps
  // -- which is why the quote is part of the prefix group. Without it the
  // pattern stopped at the `"` in {"authorization":"Bearer ..."} and matched
  // nothing, despite this comment having claimed JSON support all along.
  { name: 'auth-header', re: /\b(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[A-Za-z0-9._~+/=-]{12,}/gi },
  // KEY=value / "key": "value" where the key name looks sensitive. The decision
  // is delegated to isSensitiveKey() rather than re-stated here: the two used to
  // disagree, and the text path was the one missing the quantity-word guard, so
  // `MAX_TOKENS=4000` was reported as `MAX_TOKENS=[redacted]`.
  {
    name: 'sensitive-assignment',
    re: /\b([A-Za-z0-9_]*(?:password|passwd|passphrase|secret|token|apikey|api[_-]?key|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s,;}\]"']+)/gi,
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

/** Whether `key = value` in free text should have its value scrubbed. */
function assignmentIsSecret(key: string): boolean {
  if (!isSensitiveKey(key)) return false;
  const words = keyWords(key);
  if (words.length > 1) return true;
  if (key === key.toUpperCase() && /[A-Z]/.test(key)) return true;
  return STANDALONE_SECRET_WORDS.has(words[0] ?? '');
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
      out = out.replace(re, (_m, prefix: string) => `${prefix}${REDACTED}`);
    } else if (name === 'url-credentials') {
      out = out.replace(re, (_m, prefix: string) => `${prefix}:${REDACTED}@`);
    } else if (name === 'sensitive-assignment') {
      out = out.replace(re, (match: string, key: string, sep: string) =>
        assignmentIsSecret(key) ? `${key}${sep}${REDACTED}` : match,
      );
    } else {
      out = out.replace(re, REDACTED);
    }
  }
  return out;
}

/** True when an object key's NAME implies its value is a secret. */
export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  const joined = words.join('');

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
      return {
        name: value.name,
        message: redactText(value.message),
        ...(value.stack ? { stack: redactText(value.stack) } : {}),
      };
    }
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1, seen));
    }

    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen);
    }
    return out;
  }

  return String(value);
}

/**
 * Redact an environment-variable map. Unlike {@link redactValue} this keeps the
 * key names (they are useful in doctor output) but drops every suspicious
 * value, and never echoes a value merely because its name looked innocuous.
 */
export function redactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    out[key] = isSensitiveKey(key) ? REDACTED : redactText(value);
  }
  return out;
}
