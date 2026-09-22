import { describe, expect, it } from 'vitest';
import { MATCH_AMBIGUITY_GAP, MATCH_SCORE_FLOOR, ProjectMatcher, contentTokens, projectLabels } from '../../../src/services/projects/matching.js';
import { normalizeLookup } from '../../../src/context/text.js';
import type { Project } from '../../../src/types/projects.js';

function project(partial: Partial<Project> & { name: string }): Project {
  return {
    id: `project:${partial.name}`,
    displayName: partial.name,
    aliases: [],
    computerId: 'build-host',
    path: `/home/user/code/${partial.name}`,
    markers: ['.git'],
    hasClaudeMd: false,
    ...partial,
  };
}

const corpus: Project[] = [
  project({
    name: 'claude-mcp-orchestrator',
    description: 'MCP orchestration server that lets Claude on Android drive Claude Code on a Linux workstation.',
  }),
  project({
    name: 'course-portal',
    displayName: 'courses.example.edu',
    aliases: ['teaching app', 'class app', 'classes'],
    description: 'FastAPI teaching application serving course materials and homework.',
  }),
  project({
    name: 'lotus-clinic',
    displayName: 'LotusClinic',
    aliases: ['lotus', 'clinic site'],
    description: 'Booking and billing site for an acupuncture clinic.',
    git: { isRepo: true, remote: 'example-org/lotus-clinic' },
  }),
  project({ name: 'home-dash', displayName: 'HomeDash', aliases: ['home dash', 'my homepage'] }),
  project({ name: 'tv', description: 'Media streaming server with a phone browser UI.' }),
  project({ name: 'assistant', displayName: 'Assistant', aliases: ['helper', 'helper runtime'] }),
];

const matcher = new ProjectMatcher(corpus);

function rank(query: string): { name: string; score: number }[] {
  return corpus
    .map((candidate) => ({ name: candidate.name, score: matcher.score(query, candidate) }))
    .sort((left, right) => right.score - left.score);
}

/**
 * The thresholds resolve() applies, IMPORTED rather than mirrored. They used to
 * be copied here as local constants, so tuning the real 0.78 or 0.16 left every
 * one of these tests passing against the old values.
 */
function resolves(query: string): string | undefined {
  const [best, next] = rank(query);
  if (!best || best.score < MATCH_SCORE_FLOOR) return undefined;
  if (next && best.score - next.score < MATCH_AMBIGUITY_GAP) return undefined;
  return best.name;
}

describe('contentTokens', () => {
  it('drops filler words that carry no identity', () => {
    expect(contentTokens('the clinic site')).toEqual(['clinic', 'site']);
    expect(contentTokens('my teaching app')).toEqual(['teaching', 'app']);
  });
});

describe('projectLabels', () => {
  it('includes description and git remote, which resolution used to ignore', () => {
    const clinic = corpus.find((candidate) => candidate.name === 'lotus-clinic')!;
    const texts = projectLabels(clinic).map((label) => label.text);
    expect(texts).toContain('Booking and billing site for an acupuncture clinic.');
    expect(texts).toContain('example-org/lotus-clinic');
  });

  it('scores an identity label above a description label', () => {
    const clinic = corpus.find((candidate) => candidate.name === 'lotus-clinic')!;
    const labels = projectLabels(clinic);
    const alias = labels.find((label) => label.text === 'clinic site')!;
    const description = labels.find((label) => label.text.startsWith('Booking'))!;
    expect(alias.weight).toBeGreaterThan(description.weight);
  });
});

describe('ProjectMatcher', () => {
  it('still matches an exact alias', () => {
    expect(resolves('clinic site')).toBe('lotus-clinic');
  });

  /**
   * The regression that produced PROJECT_NOT_FOUND in production: one filler
   * word dropped an exact alias from 1.0 to 0.733, under the 0.78 threshold.
   */
  it('is not defeated by a leading article', () => {
    const clinic = corpus.find((candidate) => candidate.name === 'lotus-clinic')!;
    expect(matcher.score('the clinic site', clinic)).toBeCloseTo(1, 5);
    expect(resolves('the clinic site')).toBe('lotus-clinic');
  });

  it('resolves a spoken phrase through the description', () => {
    expect(resolves('the mcp server')).toBe('claude-mcp-orchestrator');
    expect(resolves('my acupuncture clinic site')).toBe('lotus-clinic');
  });

  it('ignores words that describe the request rather than the project', () => {
    expect(matcher.queryTokens('the mcp server I wrote for claude')).not.toContain('wrote');
    expect(resolves('the mcp server I wrote for claude')).toBe('claude-mcp-orchestrator');
  });

  it('matches on the github remote', () => {
    expect(resolves('example-org/lotus-clinic')).toBe('lotus-clinic');
  });

  it('tolerates clipped and plural forms', () => {
    expect(resolves('the app for my classes')).toBe('course-portal');
  });

  it('still finds nothing for a project that does not exist', () => {
    expect(rank('the quarterly budget spreadsheet')[0]!.score).toBeLessThan(MATCH_SCORE_FLOOR);
  });

  /**
   * Review findings from the panel, each an actual defect in the first cut.
   *
   * "not" reached the corpus through a project description and became the only
   * scoreable word in this phrase, scoring 0.85 against three unrelated
   * projects. Vague words are dropped, and full coverage of a single common
   * word is discounted rather than trusted.
   */
  it('does not manufacture candidates from vague words', () => {
    expect(matcher.queryTokens('some project that does not exist')).not.toContain('not');
    expect(rank('some project that does not exist')[0]!.score).toBeLessThan(0.55);
  });

  it('pools evidence split across two labels', () => {
    // "lotus" is the name, "acupuncture" only the description; neither label
    // covers the phrase alone.
    expect(resolves('lotus acupuncture')).toBe('lotus-clinic');
  });

  it('does not route a mostly-unknown request to an existing project', () => {
    // "mcp" is the only corpus word here, but this asks for a NEW project.
    expect(rank('new private mcp')[0]!.score).toBeLessThan(MATCH_SCORE_FLOOR);
  });

  it('cannot be pushed over the specificity floor by repetition', () => {
    const once = rank('app')[0]!.score;
    const many = rank('app app app app app app')[0]!.score;
    expect(many).toBeCloseTo(once, 5);
  });

  it('keeps the project id matchable', () => {
    const clinic = corpus.find((candidate) => candidate.name === 'lotus-clinic')!;
    expect(projectLabels(clinic).map((label) => label.text)).toContain(clinic.id);
  });

  /**
   * similarity() is whole-string Levenshtein run once per label per project,
   * so query length used to translate almost linearly into blocking CPU:
   * measured on the real 28-project corpus, ~27ms per KB, which put a 256KB
   * body (the server limit) at roughly seven seconds of event loop.
   *
   * Asserted on the normalised length rather than elapsed time, because a
   * stopwatch cannot tell a bounded input from a fast machine.
   */
  it('refuses to consider an unbounded query length', () => {
    const huge = 'mcp server '.repeat(30_000); // ~330KB
    expect(huge.length).toBeGreaterThan(256 * 1024);
    expect(normalizeLookup(huge).length).toBeLessThanOrEqual(512);
  });

  it('leaves any realistic query completely untouched', () => {
    const realistic = 'the mcp server I wrote for claude';
    // normalizeLookup lowercases by design; what matters is that nothing is cut.
    expect(normalizeLookup(realistic)).toBe(realistic.toLowerCase());
    expect(normalizeLookup(realistic)).toHaveLength(realistic.length);
  });

  it('bounds the work an oversized query can force', () => {
    // DISTINCT tokens. This used to be 'mcp '.repeat(5000) -- five thousand
    // copies of ONE word, which prepare() deduplicates to a single token, so
    // the <=24 cap was satisfied before any capping happened and the test
    // bounded nothing. Five thousand different tokens is the input that
    // actually exercises the limit.
    const huge = Array.from({ length: 5000 }, (_, index) => `tok${index}`).join(' ');
    const distinct = new Set(huge.split(' ')).size;
    expect(distinct).toBe(5000);

    const started = Date.now();
    const tokens = matcher.queryTokens(huge);
    expect(tokens.length).toBeLessThanOrEqual(24);
    // And the cap is what limited it, not deduplication.
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not let a description match outrank the project actually named', () => {
    // "tv" is a name; "media streaming" only appears in its description.
    expect(resolves('tv')).toBe('tv');
  });
});
