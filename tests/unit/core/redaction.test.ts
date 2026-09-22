import { describe, expect, it } from 'vitest';
import { isSensitiveKey, redactEnv, redactText, redactValue } from '../../../src/security/redaction.js';

describe('redactText', () => {
  it('redacts Anthropic, OpenAI, GitHub and Google keys', () => {
    const input = [
      'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
      'openai sk-abcdefghijklmnopqrstuvwxyz0123456789',
      'gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'google AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456',
    ].join('\n');
    const out = redactText(input);
    expect(out).not.toContain('sk-ant-api03');
    expect(out).not.toContain('ghp_ABCDEF');
    expect(out).not.toContain('AIzaSy');
    expect(out).toContain('[redacted]');
  });

  it('redacts bearer tokens in an Authorization header while keeping the label', () => {
    const out = redactText('Authorization: Bearer abcdef1234567890abcdef');
    expect(out).toContain('Authorization:');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('abcdef1234567890');
  });

  it('redacts KEY=VALUE assignments with sensitive names', () => {
    const out = redactText('DATABASE_PASSWORD=hunter2supersecret AND OTHER=fine');
    expect(out).not.toContain('hunter2supersecret');
    expect(out).toContain('OTHER=fine');
  });

  it('redacts a private key block', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabcdefg\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactText(pem)).toBe('[redacted]');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'The navigation component lives in src/components/Nav.tsx and the tests passed.';
    expect(redactText(prose)).toBe(prose);
  });

  it('does not corrupt a normal git sha or file path', () => {
    const text = 'commit 3ed678d changed frontend/player.js';
    expect(redactText(text)).toBe(text);
  });
});

describe('redactValue', () => {
  it('drops values of sensitive keys entirely', () => {
    const out = redactValue({ apiKey: 'sk-ant-secret', name: 'ok' }) as Record<string, unknown>;
    expect(out['apiKey']).toBe('[redacted]');
    expect(out['name']).toBe('ok');
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactValue({ a: [{ password: 'x' }, { safe: 'y' }] }) as Record<string, unknown>;
    const arr = out['a'] as Array<Record<string, unknown>>;
    expect(arr[0]?.['password']).toBe('[redacted]');
    expect(arr[1]?.['safe']).toBe('y');
  });

  it('handles circular references without throwing', () => {
    const circular: Record<string, unknown> = { name: 'root' };
    circular['self'] = circular;
    const out = redactValue(circular) as Record<string, unknown>;
    expect(out['self']).toBe('[circular]');
  });

  it('serialises Errors with a redacted message', () => {
    const out = redactValue(new Error('failed with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')) as Record<string, unknown>;
    expect(String(out['message'])).toContain('[redacted]');
  });

  it('truncates beyond the depth limit rather than recursing forever', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 30; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redactValue(deep))).toContain('[truncated]');
  });
});

describe('isSensitiveKey / redactEnv', () => {
  it('flags credential-shaped names', () => {
    for (const key of [
      'API_KEY',
      'apiKey',
      'password',
      'authToken',
      'CLIENT_SECRET',
      'privateKey',
      'accessToken',
      'refresh_token',
      'MCP_ORCHESTRATOR_TOKEN',
      'cookie',
      'passphrase',
      'sessionKey',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  // Over-redaction is a real bug, not a safe default: replacing a token COUNT
  // with "[redacted]" corrupts the payload and hides diagnostics. This was a
  // genuine defect - estimatedTokens was being returned as a string.
  it('does NOT flag token counts, budgets or other innocent names', () => {
    for (const key of [
      'estimatedTokens',
      'maxTokens',
      'budgetTokens',
      'tokenCount',
      'totalTokens',
      'inputTokens',
      'outputTokens',
      'maxThinkingTokens',
      'authMode',
      'author',
      'PATH',
      'HOME',
      'keyCount',
      'spinner',
      'pinned',
      'description',
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('still scrubs a secret VALUE even under an innocent key', () => {
    // Key matching is a convenience; value patterns are the real defence.
    const out = redactValue({ estimatedTokens: 733, note: 'use sk-ant-api03-AAAAAAAAAAAAAAAAAAAA' }) as Record<string, unknown>;
    expect(out['estimatedTokens']).toBe(733);
    expect(String(out['note'])).not.toContain('sk-ant-api03');
  });

  it('keeps env names but hides sensitive values', () => {
    const out = redactEnv({ HOME: '/home/user', MEM0_API_KEY: 'super-secret-value' });
    expect(out['HOME']).toBe('/home/user');
    expect(out['MEM0_API_KEY']).toBe('[redacted]');
  });
});

/**
 * Eleven value patterns existed; four had any test at all. A probe that fed
 * each pattern a REAL credential of its kind found seven live leaks, listed
 * here as the tests that now pin them. The discipline worth keeping: a
 * redaction test must use the format the vendor actually issues today, not the
 * format the regex was written against.
 */
describe('redactText covers the credential formats actually issued', () => {
  const leaks = (text: string): void => {
    const out = redactText(text);
    expect(out).toContain('[redacted]');
    // The whole secret is gone, not merely a prefix of it.
    for (const secret of text.split(/\s+/).filter((part) => part.length >= 20)) {
      expect(out).not.toContain(secret);
    }
  };

  it('redacts OpenAI project and service-account keys, not just the classic form', () => {
    // sk-proj- bodies contain "-" and "_"; a [A-Za-z0-9]+ body stopped at the
    // first dash and matched nothing.
    leaks(`sk-proj-${'a'.repeat(48)}`);
    leaks(`sk-svcacct-${'b'.repeat(48)}`);
    leaks(`sk-proj-ab-cd_${'e'.repeat(40)}`);
    leaks(`sk-${'c'.repeat(48)}`);
  });

  it('redacts fine-grained GitHub PATs as well as gh?_ tokens', () => {
    leaks(`github_pat_11ABCDEFG0${'c'.repeat(59)}`);
    leaks(`ghp_${'d'.repeat(36)}`);
    leaks(`ghs_${'e'.repeat(36)}`);
  });

  it('redacts every Slack token family, including the cookie and app-level ones', () => {
    leaks(`xoxb-1234567890-1234567890-${'f'.repeat(24)}`);
    leaks(`xoxd-${'g'.repeat(40)}`);
    leaks(`xapp-1-A012345-123456-${'h'.repeat(32)}`);
  });

  it('redacts AWS access key ids of the right length and leaves malformed ones alone', () => {
    leaks('AKIAIOSFODNN7EXAMPLE');
    leaks('ASIAIOSFODNN7EXAMPLE');
    // 19 characters is not a key id, and matching it would widen the pattern
    // for no gain.
    expect(redactText('AKIAIOSFODNN7EXAMPL')).toBe('AKIAIOSFODNN7EXAMPL');
  });

  it('redacts a JWT', () => {
    leaks('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });

  it('redacts Tailscale auth and api keys', () => {
    leaks(`tskey-auth-kf3ABC1CNTRL-${'i'.repeat(20)}`);
    leaks(`tskey-api-kf3ABC1CNTRL-${'j'.repeat(20)}`);
  });

  it('redacts credentials in a URL userinfo', () => {
    const out = redactText('fetch failed for https://svc:s3cr3tp4ssw0rd@internal.example/api');
    expect(out).not.toContain('s3cr3tp4ssw0rd');
    // The host survives, because that is the part that makes the log useful.
    expect(out).toContain('internal.example/api');
  });

  it('redacts a bearer token inside a JSON dump, not only a header line', () => {
    // The pattern's own comment claimed JSON support; the closing quote after
    // the key stopped it dead, so this shape leaked in full.
    const out = redactText(`{"authorization":"Bearer ${'l'.repeat(40)}"}`);
    expect(out).not.toContain('l'.repeat(40));
    expect(out).toContain('[redacted]');
  });

  it('redacts a lowercase assignment as well as a screaming one', () => {
    expect(redactText(`anthropic_api_key=${'n'.repeat(40)}`)).not.toContain('n'.repeat(40));
    expect(redactText(`ANTHROPIC_API_KEY=${'n'.repeat(40)}`)).not.toContain('n'.repeat(40));
    expect(redactText(`https://api.example/v1?access_token=${'p'.repeat(40)}`)).not.toContain('p'.repeat(40));
    expect(redactText('password=hunter2')).toBe('password=[redacted]');
  });
});

/**
 * The counterweight. Redaction that eats diagnostics gets turned off, so the
 * false-positive cases are as load-bearing as the true-positive ones -- and
 * this is not hypothetical: isSensitiveKey grew a quantity-word guard because
 * the token budget was being reported as "[redacted]", and the free-text path
 * never got the same guard, so `MAX_TOKENS=4000` stayed broken in logs.
 */
describe('redactText leaves diagnostics readable', () => {
  it('does not redact a token COUNT written as an assignment', () => {
    expect(redactText('MAX_TOKENS=4000')).toBe('MAX_TOKENS=4000');
    expect(redactText('OUTPUT_TOKENS: 1200')).toBe('OUTPUT_TOKENS: 1200');
    expect(redactText('budget TOKEN_LIMIT=8192 reached')).toBe('budget TOKEN_LIMIT=8192 reached');
    expect(redactText('CACHE_TOKENS=0')).toBe('CACHE_TOKENS=0');
  });

  it('agrees with isSensitiveKey rather than keeping a second copy of the policy', () => {
    // Every key the object path considers safe must also be safe in text, and
    // vice versa. Drift between these two is the bug above.
    for (const key of ['MAX_TOKENS', 'TOKEN_LIMIT', 'CACHE_TOKENS', 'estimated_tokens']) {
      expect(isSensitiveKey(key)).toBe(false);
      expect(redactText(`${key}=1234`)).toContain('1234');
    }
    for (const key of ['ACCESS_TOKEN', 'api_key', 'client_secret', 'refresh_token']) {
      expect(isSensitiveKey(key)).toBe(true);
      expect(redactText(`${key}=abcdefghijklmnop`)).not.toContain('abcdefghijklmnop');
    }
  });

  it('does not eat prose that happens to contain a credential noun', () => {
    // A bare lowercase word followed by a colon is a log line, not a leak.
    expect(redactText('token: expired')).toBe('token: expired');
    expect(redactText('signature: v2')).toBe('signature: v2');
  });

  it('leaves a hash or a git object id alone', () => {
    // These are the reason the bare-40-char-base64 shape is deliberately not
    // matched: an AWS secret key is indistinguishable from them.
    const sha = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
    expect(redactText(`HEAD is ${sha}`)).toBe(`HEAD is ${sha}`);
  });
});
