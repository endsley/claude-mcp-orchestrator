import { describe, expect, it } from 'vitest';
import { ProjectMatcher, contentTokens, projectLabels } from '../../../src/services/projects/matching.js';
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
    name: 'UserClass_V2',
    displayName: 'courses.example.edu',
    aliases: ['teaching app', 'class app', 'classes'],
    description: 'FastAPI teaching application serving course materials and homework.',
  }),
  project({
    name: 'lotus-clinic',
    displayName: 'LotusClinic',
    aliases: ['lotus clinic', 'clinic site'],
    description: 'Booking and billing site for an acupuncture clinic.',
    git: { isRepo: true, remote: 'workstation/lotus-clinic' },
  }),
  project({ name: 'homeDash', displayName: 'HomeDash', aliases: ['home dash', 'my homepage'] }),
  project({ name: 'tv', description: 'Media streaming server with a phone browser UI.' }),
  project({ name: 'assistant', displayName: 'Assistant', aliases: ['jane', 'jane runtime'] }),
];

const matcher = new ProjectMatcher(corpus);

function rank(query: string): { name: string; score: number }[] {
  return corpus
    .map((candidate) => ({ name: candidate.name, score: matcher.score(query, candidate) }))
    .sort((left, right) => right.score - left.score);
}

/** The thresholds resolve() applies, mirrored so the tests assert real outcomes. */
const MATCH_SCORE = 0.78;
const MATCH_GAP = 0.16;

function resolves(query: string): string | undefined {
  const [best, next] = rank(query);
  if (!best || best.score < MATCH_SCORE) return undefined;
  if (next && best.score - next.score < MATCH_GAP) return undefined;
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
    const lotus-clinic = corpus.find((candidate) => candidate.name === 'lotus-clinic')!;
    const texts = projectLabels(lotus-clinic).map((label) => label.text);
    expect(texts).toContain('Booking and billing site for an acupuncture clinic.');
    expect(texts).toContain('workstation/lotus-clinic');
  });

  it('scores an identity label above a description label', () => {
    const lotus-clinic = corpus.find((candidate) => candidate.name === 'lotus-clinic')!;
    const labels = projectLabels(lotus-clinic);
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
    expect(matcher.score('the clinic site', corpus[2]!)).toBeCloseTo(1, 5);
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
    expect(resolves('workstation/lotus-clinic')).toBe('lotus-clinic');
  });

  it('tolerates clipped and plural forms', () => {
    expect(resolves('the app for my classes')).toBe('UserClass_V2');
  });

  it('still finds nothing for a project that does not exist', () => {
    expect(rank('the quarterly budget spreadsheet')[0]!.score).toBeLessThan(MATCH_SCORE);
  });

  /**
   * Regression: "not" reached the corpus through a project description and
   * became the only scoreable word in this phrase, scoring 0.85 against three
   * unrelated projects. Vague words are dropped, and full coverage of a
   * single common word is discounted rather than trusted.
   */
  it('does not manufacture candidates from vague words', () => {
    expect(matcher.queryTokens('some project that does not exist')).not.toContain('not');
    expect(rank('some project that does not exist')[0]!.score).toBeLessThan(0.55);
  });

  /** Review findings from the panel, each an actual defect in the first cut. */
  it('pools evidence split across two labels', () => {
    // "lotus-clinic" is the name, "acupuncture" only the description; neither
    // label covers the phrase alone.
    expect(resolves('lotus-clinic acupuncture')).toBe('lotus-clinic');
  });

  it('does not route a mostly-unknown request to an existing project', () => {
    // "mcp" is the only corpus word here, but this asks for a NEW project.
    expect(rank('new private mcp')[0]!.score).toBeLessThan(MATCH_SCORE);
  });

  it('cannot be pushed over the specificity floor by repetition', () => {
    const once = rank('app')[0]!.score;
    const many = rank('app app app app app app')[0]!.score;
    expect(many).toBeCloseTo(once, 5);
  });

  it('keeps the project id matchable', () => {
    const lotus-clinic = corpus.find((candidate) => candidate.name === 'lotus-clinic')!;
    expect(projectLabels(lotus-clinic).map((label) => label.text)).toContain(lotus-clinic.id);
  });

  it('bounds the work an oversized query can force', () => {
    const huge = 'mcp '.repeat(5000);
    const started = Date.now();
    expect(matcher.queryTokens(huge).length).toBeLessThanOrEqual(24);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not let a description match outrank the project actually named', () => {
    // "tv" is a name; "media streaming" only appears in its description.
    expect(resolves('tv')).toBe('tv');
  });
});
