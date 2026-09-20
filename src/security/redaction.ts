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
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{32,}/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'tailscale-key', re: /\btskey-[A-Za-z0-9-]{10,}/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // `Authorization: Bearer <token>` in any casing, including inside JSON dumps.
  { name: 'auth-header', re: /\b(authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9._~+/=-]{12,}/gi },
  // KEY=value / KEY: value where the key name looks sensitive.
  {
    name: 'sensitive-assignment',
    re: /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/g,
  },
];

/** Redact secrets from a free-text string. */
export function redactText(input: string): string {
  if (input === '') return input;
  let out = input;
  for (const { re, name } of VALUE_PATTERNS) {
    // Patterns with capture groups keep the harmless prefix so the log still
    // says WHICH setting was scrubbed.
    if (name === 'auth-header') {
      out = out.replace(re, (_m, prefix: string) => `${prefix}${REDACTED}`);
    } else if (name === 'sensitive-assignment') {
      out = out.replace(re, (_m, key: string) => `${key}=${REDACTED}`);
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
