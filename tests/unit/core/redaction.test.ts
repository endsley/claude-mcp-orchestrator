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
