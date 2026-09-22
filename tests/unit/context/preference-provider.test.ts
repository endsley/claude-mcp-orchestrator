import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreferenceContextProvider } from '../../../src/context/providers/preference-provider.js';

/**
 * "No rules" and "the rules could not be read" are different facts.
 *
 * The provider caught every read error alike, so a permissions or I/O failure
 * produced a section titled "OPERATING RULES (the worker is bound by these)"
 * with nothing under it -- identical to a fresh machine. The only conclusion
 * available from that text is that the user has no standing rules, and these
 * are precisely the constraints the user placed ON the worker. Failing silently
 * in that direction means the worker proceeds believing itself unconstrained.
 *
 * Found by asking what the system silently drops (endsley/bodhi-inbox#37).
 */
let dir: string;
let locked: string;
let readable: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'preference-provider-'));
  locked = join(dir, 'locked.md');
  writeFileSync(locked, '- Never force push to main.\n- Always run the tests.\n');
  chmodSync(locked, 0o000);
  readable = join(dir, 'rules.md');
  writeFileSync(readable, '- Never force push to main.\n- Always run the tests before pushing.\n');
});

afterAll(() => {
  try {
    chmodSync(locked, 0o600);
  } catch {
    // Best effort; the directory is going away regardless.
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('PreferenceContextProvider', () => {
  it('says nothing when an instruction file is simply absent', async () => {
    // ENOENT is the normal state of a fresh machine and must stay quiet, or
    // the warning becomes background noise and stops being read.
    const provider = new PreferenceContextProvider({ instructionFiles: [join(dir, 'nope.md')] });
    const section = await provider.getContext({} as never);
    expect(section.lines.some((line) => line.startsWith('WARNING'))).toBe(false);
  });

  it('warns IN THE SECTION when a file exists but cannot be read', async () => {
    // In the section, not only in health(): health is reached through
    // list_context_capabilities, while this text is what the worker reads.
    const provider = new PreferenceContextProvider({ instructionFiles: [locked] });
    const section = await provider.getContext({} as never);
    const warning = section.lines.find((line) => line.startsWith('WARNING'));
    expect(warning).toBeDefined();
    expect(warning).toContain('locked.md');
    expect(warning).toMatch(/missing/i);
  });

  it('reports unreadable as degraded health, distinct from absent', async () => {
    const provider = new PreferenceContextProvider({ instructionFiles: [locked] });
    const health = await provider.health();
    expect(health.status).toBe('degraded');
    expect(health.detail).toContain('could not be read');
    // Not the same message as a missing file, which is the whole point.
    expect(health.detail).not.toMatch(/no instruction files found/);
  });

  it('still reads a readable file without complaint', async () => {
    const provider = new PreferenceContextProvider({ instructionFiles: [readable] });
    const section = await provider.getContext({} as never);
    expect(section.lines.some((line) => line.startsWith('WARNING'))).toBe(false);
    expect(section.lines.some((line) => /force push/i.test(line))).toBe(true);
    expect((await provider.health()).status).toBe('ok');
  });
});
