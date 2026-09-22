import { normalizeLookup, similarity } from '../../context/text.js';
import type { Project } from '../../types/projects.js';

/**
 * Filler a person says around a project name. "the clinic site" and
 * "clinic site" name the same thing, so the article must not count against
 * the match - whole-string edit distance charged for it and pushed exact
 * aliases under the match threshold.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'did', 'do', 'does',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'him', 'his', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'she', 'so', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'will', 'with', 'would', 'you', 'your',
  // Vague quantifiers and negations. "not" reached the corpus through a
  // project description and became the only scoreable word in "some project
  // that does not exist", which then scored 0.85 against three unrelated
  // projects.
  'about', 'after', 'again', 'all', 'also', 'any', 'because', 'been', 'before',
  'being', 'both', 'could', 'during', 'each', 'exist', 'get', 'got', 'how',
  'just', 'may', 'might', 'more', 'most', 'must', 'need', 'no', 'none', 'nor',
  'not', 'now', 'only', 'other', 'out', 'over', 'own', 'same', 'should', 'some',
  'such', 'too', 'under', 'very', 'want', 'well', 'while', 'why',
]);

/**
 * Identity labels are what the project IS called; the supporting labels are
 * evidence about it. For equal coverage an identity match therefore outranks
 * a description match. This is a ranking preference, not a guarantee: strong
 * coverage of a description can still beat weak, partial coverage of a name,
 * which is intended - "the acupuncture booking site" should find a clinic app.
 */
const IDENTITY_WEIGHT = 1;
const REMOTE_WEIGHT = 0.95;
const PATH_WEIGHT = 0.9;
const DESCRIPTION_WEIGHT = 0.85;
/** Evidence pooled across several labels is real but never better than prose. */
const COMBINED_WEIGHT = DESCRIPTION_WEIGHT;

/** Bounds the fuzzy comparisons an unbounded MCP query can force. */
const MAX_QUERY_TOKENS = 24;

export interface WeightedLabel {
  text: string;
  weight: number;
  /**
   * False for opaque handles. An id is `project:<sha256>`, so tokenising it
   * puts the literal word "project" into the vocabulary of every project and
   * lets a throwaway phrase like "some project that does not exist" score
   * against all of them. Ids stay matchable by whole-string similarity only.
   */
  tokenize?: boolean;
}

export interface PreparedQuery {
  /** Deduplicated tokens that some project could actually match. */
  tokens: string[];
  /** How many informative words the query had before that filter. */
  contentCount: number;
  normalized: string;
}

export function contentTokens(value: string): string[] {
  const normalized = normalizeLookup(value);
  if (!normalized) return [];
  return normalized.split(' ').filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * Every string a person might use to refer to this project, with how much
 * trust a match on it earns.
 *
 * `description` and `git.remote` are here because the registry populates them
 * (26 of 28 projects on the dev host) and resolution previously ignored both:
 * the model could read "MCP orchestration server" in the project list and
 * still get PROJECT_NOT_FOUND for "the mcp server". `id` is retained from the
 * original label set so an id-shaped query keeps its fuzzy path, though it is
 * not tokenised.
 */
export function projectLabels(project: Project): WeightedLabel[] {
  const labels: WeightedLabel[] = [
    { text: project.id, weight: IDENTITY_WEIGHT, tokenize: false },
    { text: project.name, weight: IDENTITY_WEIGHT },
    { text: project.displayName, weight: IDENTITY_WEIGHT },
    ...(project.aliases ?? []).map((alias) => ({ text: alias, weight: IDENTITY_WEIGHT })),
    { text: project.path, weight: PATH_WEIGHT },
  ];
  if (project.git?.remote) labels.push({ text: project.git.remote, weight: REMOTE_WEIGHT });
  if (project.description) labels.push({ text: project.description, weight: DESCRIPTION_WEIGHT });
  return labels.filter((label) => typeof label.text === 'string' && label.text.length > 0);
}

/**
 * Tolerant single-token comparison: plurals and clipped forms ("class" for
 * "classes", "lotus" for "lotusclinic") should match, and so should a small
 * transcription slip from voice input.
 */
function tokenMatches(token: string, labelTokens: Set<string>): boolean {
  if (labelTokens.has(token)) return true;
  for (const candidate of labelTokens) {
    if (token.length >= 4 && candidate.length >= 4 && (candidate.startsWith(token) || token.startsWith(candidate))) {
      return true;
    }
    if (Math.abs(candidate.length - token.length) <= 2 && similarity(token, candidate) >= 0.86) return true;
  }
  return false;
}

interface LabelIndex {
  label: WeightedLabel;
  tokens: Set<string>;
}

interface ProjectIndex {
  labels: LabelIndex[];
  /** Union of every label's tokens, for evidence split across labels. */
  combined: Set<string>;
}

/**
 * Scores a query against projects using how many of its *informative* words a
 * label accounts for, rather than the edit distance of the whole phrase.
 *
 * Rare words decide the match. "server" and "app" appear across the corpus and
 * separate nothing; "mcp" and "acupuncture" identify one project each, so they
 * are weighted by inverse document frequency over the labels actually present.
 *
 * The index is built once from the project snapshot handed to the constructor
 * and never mutates, so a caller must build one per resolution against the
 * same snapshot it scores.
 */
/**
 * When a fuzzy score is good enough to act on, and when it is too close to call.
 *
 * These lived as bare 0.78 and 0.16 inline at two call sites -- the project
 * registry and the computer service -- and a THIRD time as mirrored constants
 * in the test, which therefore asserted against its own copy rather than
 * against what resolve() does. Tuning the real numbers would have left every
 * test passing. Same drift this codebase has already been bitten by when a
 * policy had two homes; one home, imported everywhere, including by the tests.
 */
export const MATCH_SCORE_FLOOR = 0.78;

/**
 * How far the best candidate must beat the runner-up. Below this the answer is
 * ambiguous and the user is asked which one they meant, which is far better
 * than picking confidently between two near-identical names.
 */
export const MATCH_AMBIGUITY_GAP = 0.16;

export class ProjectMatcher {
  private readonly documentFrequency = new Map<string, number>();
  private readonly vocabulary = new Set<string>();
  private readonly indexes = new Map<string, ProjectIndex>();
  private readonly total: number;

  constructor(projects: Project[]) {
    this.total = projects.length;
    for (const project of projects) {
      const labels = projectLabels(project).map((label) => ({
        label,
        tokens: new Set(label.tokenize === false ? [] : contentTokens(label.text)),
      }));
      const combined = new Set<string>();
      for (const entry of labels) for (const token of entry.tokens) combined.add(token);
      this.indexes.set(project.id, { labels, combined });
      for (const token of combined) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
        this.vocabulary.add(token);
      }
    }
  }

  private weightOf(token: string): number {
    return Math.log(1 + this.total / (1 + (this.documentFrequency.get(token) ?? 0)));
  }

  /**
   * Tokenise once per resolution. Fuzzy-matching each query word against the
   * whole vocabulary is the expensive step, and it does not vary by project.
   */
  prepare(query: string): PreparedQuery {
    const content = contentTokens(query).slice(0, MAX_QUERY_TOKENS);
    const unique = [...new Set(content)];
    // Words no project could match ("wrote" in "the mcp server I wrote")
    // describe the request, not the target. Counting them as misses is what
    // turned near-misses into not_found.
    const addressable = unique.filter((token) => tokenMatches(token, this.vocabulary));
    return {
      tokens: addressable.length > 0 ? addressable : unique,
      contentCount: unique.length,
      normalized: normalizeLookup(query),
    };
  }

  /** Convenience for callers that score a single project. */
  score(query: string, project: Project): number {
    return this.scorePrepared(this.prepare(query), project);
  }

  queryTokens(query: string): string[] {
    return this.prepare(query).tokens;
  }

  scorePrepared(prepared: PreparedQuery, project: Project): number {
    const index = this.indexes.get(project.id);
    if (index === undefined) return 0;
    const penalty = this.unknownPenalty(prepared);
    let best = 0;
    for (const entry of index.labels) {
      // Whole-string similarity is retained so existing near-exact and
      // typo-tolerant behaviour on identity labels is unchanged.
      best = Math.max(best, similarity(prepared.normalized, entry.label.text) * entry.label.weight);
      best = Math.max(best, this.coverage(prepared, entry.tokens) * entry.label.weight * penalty);
    }
    // A query can name the project in one label and describe it in another
    // ("LotusClinic acupuncture"); neither label covers it alone.
    best = Math.max(best, this.coverage(prepared, index.combined) * COMBINED_WEIGHT * penalty);
    return best;
  }

  private coverage(prepared: PreparedQuery, labelTokens: Set<string>): number {
    if (labelTokens.size === 0 || prepared.tokens.length === 0) return 0;
    let matched = 0;
    let possible = 0;
    for (const token of prepared.tokens) {
      const weight = this.weightOf(token);
      possible += weight;
      if (tokenMatches(token, labelTokens)) matched += weight;
    }
    if (possible === 0) return 0;
    return (matched / possible) * this.specificity(matched);
  }

  /**
   * Full coverage of one vague word is not evidence. Without this, a query
   * whose only corpus-known token was "not" scored 0.85 against three
   * unrelated projects. Matches must clear roughly the weight of a single
   * token that names one project, so a common word alone is discounted.
   */
  private specificity(matchedMass: number): number {
    if (this.total === 0) return 0;
    const floor = Math.log(1 + this.total / 4);
    return floor <= 0 ? 1 : Math.min(1, matchedMass / floor);
  }

  /**
   * Dropping unmatchable words is right for a stray verb and wrong for a
   * query that is mostly words we have never seen: "new private mcp" is not a
   * request for the existing MCP project. Tolerate a minority of unknowns,
   * discount when they are the majority.
   */
  private unknownPenalty(prepared: PreparedQuery): number {
    if (prepared.contentCount === 0) return 1;
    const known = prepared.tokens.filter((token) => tokenMatches(token, this.vocabulary)).length;
    const share = known / prepared.contentCount;
    return share >= 0.5 ? 1 : Math.max(0, share * 2);
  }
}
