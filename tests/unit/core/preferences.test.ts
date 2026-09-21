import { describe, expect, it } from 'vitest';
import { extractRules } from '../../../src/context/providers/preference-provider.js';

/**
 * The remote model must receive the CONSTRAINTS the local worker is bound by.
 * Handing it a sentence saying "preferences exist" is worse than nothing: it
 * then delegates work while ignorant of the rules.
 */
describe('extractRules', () => {
  const doc = [
    '# Rules',
    '',
    '## Git Discipline (MANDATORY)',
    '',
    '**Always `git pull` before editing.** Run it in the repository you are',
    'about to touch, as the first action of the task.',
    '',
    '**NEVER `git add -A`**, `git add .`, or `git commit -a` in a shared tree.',
    '',
    'Do this at the start of every coding task, in order:',
    '',
    '1. ListAgents to see which peers are live.',
    '',
    '```bash',
    'git status --porcelain',
    '```',
    '',
    '## Prose',
    '',
    'This paragraph is ordinary narrative and should not be treated as a rule.',
    '',
  ].join('\n');

  it('extracts imperative rules as complete sentences', () => {
    const rules = extractRules(doc, 10);
    expect(rules.some((r) => r.startsWith('Always git pull before editing.'))).toBe(true);
    // Joined across the wrapped line, not truncated mid-clause.
    expect(rules.find((r) => r.startsWith('Always git pull'))).toContain('first action of the task');
  });

  it('keeps hard prohibitions', () => {
    expect(extractRules(doc, 10).some((r) => r.includes('NEVER git add -A'))).toBe(true);
  });

  it('drops list-introducing colons, numbered runbook steps and code fences', () => {
    const rules = extractRules(doc, 10);
    expect(rules.some((r) => r.endsWith(':'))).toBe(false);
    expect(rules.some((r) => /^\d+\.\s/.test(r))).toBe(false);
    expect(rules.some((r) => r.includes('git status --porcelain'))).toBe(false);
  });

  it('ignores ordinary prose outside rule-bearing sections', () => {
    expect(extractRules(doc, 10).some((r) => r.includes('ordinary narrative'))).toBe(false);
  });

  it('honours the rule cap', () => {
    expect(extractRules(doc, 1)).toHaveLength(1);
  });

  it('returns nothing for an empty document rather than throwing', () => {
    expect(extractRules('', 5)).toEqual([]);
  });
});
