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

/**
 * Round two, from an adversarial review that ran against the previous commit
 * (endsley/bodhi-inbox#28). Of nine claimed pattern gaps, three were already
 * fixed, three were not real formats, and three were. The three real ones plus
 * two the review found that the pattern probe had not are pinned here.
 */
describe('redactText round two', () => {
  it('redacts any auth scheme, not just Bearer', () => {
    // Basic is a password in base64. Pinning the scheme to "bearer" made the
    // optional group fail, the 12-char body then had to match "Basic" itself,
    // and the whole pattern missed.
    // The SCHEME survives -- which scheme was used is diagnostics, and keeping
    // the harmless prefix is what this pattern does everywhere else.
    expect(redactText('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Authorization: Basic [redacted]');
    expect(redactText(`Proxy-Authorization: Bearer ${'k'.repeat(40)}`)).toBe('Proxy-Authorization: Bearer [redacted]');
    expect(redactText(`authorization: Token ${'k'.repeat(40)}`)).toContain('[redacted]');
  });

  it('redacts all five segments of a JWE, not the first three', () => {
    const jwe = 'eyJhbGciOiJkaXIifQ.eyJzdWIiOiIxIn0.FAKEctFAKEct.FAKEivFAKEiv.FAKEtagFAKEtag';
    // Stopping at three left the ciphertext and the authentication tag behind.
    expect(redactText(jwe)).toBe('[redacted]');
  });

  it('redacts any key isSensitiveKey considers sensitive, not a hand-listed few', () => {
    // These three were sensitive to the object path and invisible to the text
    // path, because the text path restated the policy as a regex alternation.
    for (const key of ['ENCRYPTION_KEY', 'SIGNING_KEY', 'SESSION_COOKIE', 'SSH_PRIVATE_KEY']) {
      expect(isSensitiveKey(key)).toBe(true);
      expect(redactText(`${key}=FAKE1234567890abcdef`)).toBe(`${key}=[redacted]`);
    }
  });

  it('finds a secret in a URL query without swallowing the URL', () => {
    // The broad key pattern first matched key "https", value
    // "//host/v1?access_token=…", found it not sensitive and consumed the real
    // secret past it. A pattern that eats text is worse than one that misses.
    const out = redactText(`GET https://api.example/v1?access_token=${'p'.repeat(40)} 200`);
    expect(out).not.toContain('p'.repeat(40));
    expect(out).toContain('https://api.example/v1?access_token=');
    expect(out).toContain('200');

    const two = redactText(`https://h/v1?api_key=${'q'.repeat(30)}&page=2`);
    expect(two).not.toContain('q'.repeat(30));
    // The non-secret parameter after it survives.
    expect(two).toContain('page=2');
  });

  it('does not corrupt a value another pattern already redacted', () => {
    // Proxy-Authorization is redacted by the auth-header pattern, then matches
    // the assignment pattern as key "Proxy-Authorization" with value
    // "[redacted" -- re-emitting the placeholder and dropping its bracket.
    expect(redactText(`Proxy-Authorization: Bearer ${'k'.repeat(40)}`)).not.toContain('[redacted]]');
    expect(redactText(`authorization: Bearer ${'k'.repeat(40)}`)).toBe('authorization: Bearer [redacted]');
  });

  it('leaves an ordinary structured log line completely alone', () => {
    // The counterweight to a broad key pattern: every pair here pays an
    // isSensitiveKey() call and every one must come back false.
    const line = 'component=main level=30 elapsedMs=12 route=/mcp status=200 host=katie';
    expect(redactText(line)).toBe(line);
  });
});

describe('redactValue handles objects that are not plain objects', () => {
  it('never byte-dumps binary data', () => {
    // A Buffer fell through to Object.entries and became {"0":115,"1":107,…},
    // which reconstructs the credential exactly and never went near
    // redactText. Verified by round-tripping the bytes.
    const secret = 'sk-ant-api03-SUPERSECRETVALUE';
    const out = redactValue({ keyBytes: Buffer.from(secret) }) as Record<string, unknown>;
    expect(out['keyBytes']).toBe(`[Buffer ${Buffer.byteLength(secret)} bytes]`);

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('115');
    expect(serialised).not.toContain(secret);
  });

  it('describes typed arrays and ArrayBuffers by shape and size', () => {
    const out = redactValue({ a: new Uint8Array([115, 107, 45]), b: new ArrayBuffer(8) }) as Record<string, unknown>;
    expect(out['a']).toBe('[Uint8Array 3 bytes]');
    expect(out['b']).toBe('[ArrayBuffer 8 bytes]');
  });

  it('keeps Map and Set contents instead of silently emptying them', () => {
    // Neither has own enumerable properties, so Object.entries returned {} and
    // the contents vanished. Losing diagnostics is not a leak, but a redactor
    // that eats data gets routed around.
    const out = redactValue({
      m: new Map<string, unknown>([['api_key', 'sk-ant-secret'], ['retries', 5]]),
      s: new Set(['plain', `sk-ant-api03-${'z'.repeat(30)}`]),
    }) as Record<string, Record<string, unknown> | unknown[]>;

    expect(out['m']).toEqual({ api_key: '[redacted]', retries: 5 });
    expect(out['s']).toEqual(['plain', '[redacted]']);
  });
});

/**
 * Round three, from the review panel on the round-two commit. Codex found five
 * things; three were defects in code written an hour earlier, and every one was
 * reproduced before being fixed. The theme is that a redactor has two separate
 * jobs -- recognising a hostile value and reading it -- and getting the first
 * right does not give you the second.
 */
describe('a harmless assignment never swallows a secret', () => {
  const secret = 'q'.repeat(40);

  it('finds a secret nested inside a harmless value', () => {
    // A global regex CONSUMES its match. "payload={access_token=…}" matched key
    // "payload", value "{access_token=…", found it harmless, and ate the secret.
    expect(redactText(`payload={access_token=${secret}}`)).toBe('payload={access_token=[redacted]}');
    expect(redactText(`a={b={api_key=${secret}}}`)).toBe('a={b={api_key=[redacted]}}');
  });

  it('handles a dotted key', () => {
    // isSensitiveKey splits on "." and called this sensitive; the key pattern
    // did not allow "." so the pair was never offered to it.
    expect(isSensitiveKey('access.token')).toBe(true);
    expect(redactText(`access.token=${secret}`)).toBe('access.token=[redacted]');
  });

  it('redacts an auth scheme whose name contains a digit', () => {
    expect(redactText('Authorization: OAuth2 a1b2c3d4e5f6g7h8')).toBe('Authorization: OAuth2 [redacted]');
  });

  it('terminates on input that is nothing but separators', () => {
    // The scan rewinds its cursor on a harmless pair, so termination depends on
    // lastIndex strictly increasing rather than on the match being consumed.
    expect(redactText('a=b=c=d=e')).toBe('a=b=c=d=e');
    expect(redactText('::::')).toBe('::::');
    expect(redactText('a:'.repeat(500))).toBe('a:'.repeat(500));
  });
});

describe('redactValue survives hostile objects without throwing', () => {
  const secret = 'sk-ant-api03-SUPERSECRETVALUE';

  it('does not byte-dump a Proxy-wrapped Buffer', () => {
    // ArrayBuffer.isView tests an internal slot a Proxy does not have, so the
    // first version of the binary guard missed this and dumped the bytes.
    // instanceof walks the prototype chain, which a Proxy forwards.
    const out = redactValue({ b: new Proxy(Buffer.from(secret), {}) }) as Record<string, unknown>;
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('115');
    expect(serialised).not.toContain(secret);
    expect(String(out['b'])).toContain('Buffer');
  });

  it('covers typed-array subclasses', () => {
    const out = redactValue({ b: new (class extends Uint8Array {})(3) }) as Record<string, unknown>;
    expect(String(out['b'])).toBe('[TypedArray 3 bytes]');
  });

  it('redacts a secret used as a Map KEY', () => {
    // new Map([[token, 'ok']]) emitted the token as a property name.
    const out = redactValue({ m: new Map([[`sk-ant-api03-${'z'.repeat(30)}`, 'ok']]) }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('zzzz');
    expect(out['m']).toEqual({ '[redacted]': 'ok' });
  });

  it('degrades rather than throwing on a collection it cannot read', () => {
    // A proxied Map passes instanceof and then throws TypeError from
    // .entries(). This runs on error paths, where throwing again destroys the
    // original failure -- the thing the caller actually wanted to log.
    expect(() => redactValue({ m: new Proxy(new Map([['a', 1]]), {}) })).not.toThrow();
    const out = redactValue({ m: new Proxy(new Map([['a', 1]]), {}) }) as Record<string, unknown>;
    expect(out['m']).toBe('[unreadable Map]');
  });

  it('never throws on any of the awkward shapes at once', () => {
    // The contract that matters: this function is called BY error handlers.
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    const hostile = {
      proxiedBuffer: new Proxy(Buffer.from(secret), {}),
      proxiedMap: new Proxy(new Map([['k', 'v']]), {}),
      proxiedSet: new Proxy(new Set([1]), {}),
      getter: Object.defineProperty({}, 'boom', { get() { throw new Error('nope'); }, enumerable: true }),
      cycle,
      deep: new Array(20).fill(0).reduce<unknown>((acc) => ({ acc }), 'leaf'),
      big: 10n,
      sym: Symbol('s'),
      fn: () => undefined,
      nan: Number.NaN,
      date: new Date(0),
      nul: null,
      undef: undefined,
    };
    expect(() => JSON.stringify(redactValue(hostile))).not.toThrow();
    expect(JSON.stringify(redactValue(hostile))).not.toContain(secret);
  });
});

/**
 * Round four, from a second reviewer on the same commit. It converged with the
 * first on the auth-header over-reach and the Proxy hole -- two reviewers that
 * cannot see each other landing on one spot is the strongest signal available
 * -- and found two things neither the first reviewer nor my own probes caught.
 */
describe('quoted values are redacted whole', () => {
  it('does not leave the tail of a quoted passphrase behind', () => {
    // The manual scan dropped the quoted alternative the original pattern had,
    // so the value ran only to the next space and three words of a four-word
    // passphrase survived. A regression introduced by the previous commit.
    expect(redactText('password="correct horse battery staple"')).toBe('password="[redacted]"');
    expect(redactText("passphrase='my long secret phrase'")).toBe("passphrase='[redacted]'");
  });

  it('keeps the quotes so the surrounding structure still parses', () => {
    expect(redactText('{"api_key": "abc 123 def"}')).toContain('"api_key": "[redacted]"');
  });

  it('still stops at whitespace when the value is unquoted', () => {
    // Unquoted, there is no way to know where the value ends, so the rest of
    // the line must survive.
    expect(redactText('api_key=abc123def456 request completed')).toBe('api_key=[redacted] request completed');
  });
});

describe('a bare credential noun is judged by its value', () => {
  it('redacts token=<unshaped secret>', () => {
    // The module's own comment claimed unshaped secrets were caught by their
    // key, while assignmentIsSecret deliberately excluded a bare lowercase
    // "token" to protect prose. Both cannot be true.
    const hex = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    expect(redactText(`token=${hex}`)).toBe('token=[redacted]');
    expect(redactText(`signature=${hex}`)).toBe('signature=[redacted]');
  });

  it('still leaves the prose form alone', () => {
    expect(redactText('token: expired')).toBe('token: expired');
    expect(redactText('signature: v2')).toBe('signature: v2');
    expect(redactText('token: not-yet-issued')).toBe('token: not-yet-issued');
  });
});

describe('the authorization header is told apart from prose about it', () => {
  it('leaves a status message after authorization: alone', () => {
    // All three ate the whole value before: a 12+ character word after the
    // colon was assumed to be a credential.
    expect(redactText('authorization: mode=api-key')).toBe('authorization: mode=api-key');
    expect(redactText('authorization: successful-login-completed')).toBe('authorization: successful-login-completed');
    expect(redactText('{"authorization":"pending-approval"}')).toBe('{"authorization":"pending-approval"}');
  });

  it('but redacts unconditionally once a scheme is present', () => {
    // A scheme is the evidence. "Scheme token" is a credential whatever the
    // token looks like, so no shape test is applied there.
    expect(redactText('authorization: Bearer pending-approval-x')).toBe('authorization: Bearer [redacted]');
  });

  it('redacts a schemeless value that does look like a credential', () => {
    expect(redactText('authorization: aB3dE5fG7hJ9kL1m')).toBe('authorization: [redacted]');
  });
});

describe('enumerating an object is as fallible as reading it', () => {
  it('does not throw when Object.keys itself is trapped', () => {
    // The getter guard added last commit covered the READ. Object.keys can
    // throw too, on a Proxy with an ownKeys trap.
    const hostile = new Proxy({}, { ownKeys() { throw new Error('nope'); } });
    expect(() => redactValue({ h: hostile })).not.toThrow();
    expect(String((redactValue({ h: hostile }) as Record<string, unknown>)['h'])).toContain('unreadable');
  });
});
