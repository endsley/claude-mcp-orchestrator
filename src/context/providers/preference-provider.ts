import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { InitialContextProvider, InitialContextRequest, InitialContextSection, ProviderHealth } from '../contracts.js';

/**
 * Operating rules distilled from the user's real Claude Code instructions.
 *
 * Local Claude Code loads the whole CLAUDE.md on every turn. A remote client
 * cannot be handed hundreds of lines on every voice turn, but handing it a
 * sentence saying "preferences exist somewhere" is worse than useless - the
 * remote model then delegates work while ignorant of the rules the local
 * worker is bound by, and asks the user things the rules already answer.
 *
 * So this extracts the RULES specifically: hard constraints and imperatives,
 * which is the part that changes what the model should do. It reads the real
 * files rather than hardcoding a summary, so editing CLAUDE.md updates the
 * remote context automatically instead of silently drifting.
 */

/** Lines that read as a binding rule rather than prose or narrative. */
const RULE_PATTERNS: RegExp[] = [
  /^\*\*(?:never|always|do not|don't)\b/i,
  /^(?:never|always|do not|don't)\b/i,
  /^\*\*[^*]{3,90}\*\*[:.]?\s*$/, // bolded rule headline, e.g. **One branch: `main`.**
];

/** Headings whose sections are worth mining even without a bold imperative. */
const IMPORTANT_HEADING = /\b(mandatory|authority|discipline|coordination|security|secret|git|environment)\b/i;

function tidy(line: string): string {
  return line
    .replace(/^[-*+]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collapse a markdown instruction file into its binding rules. */
export function extractRules(markdown: string, maxRules: number): string[] {
  const rules: string[] = [];
  const seen = new Set<string>();
  let heading = '';
  let inCodeFence = false;
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length === 0) return;
    // Join the paragraph before matching. Rules in CLAUDE.md are wrapped across
    // several lines, so testing line-by-line yields sentence fragments that are
    // confusing when read aloud.
    const joined = tidy(paragraph.join(' '));
    paragraph = [];

    if (rules.length >= maxRules) return;
    const first = joined.toLowerCase();
    const isRule =
      RULE_PATTERNS.some((pattern) => pattern.test(joined)) ||
      /^(never|always|do not|don't|prefer|assume|use|run)\b/.test(first) ||
      (IMPORTANT_HEADING.test(heading) && joined.length > 30);
    if (!isRule) return;

    // A line ending in a colon introduces a list; on its own it says nothing.
    if (joined.endsWith(':')) return;
    if (joined.length < 20) return;
    // Numbered checklists are step-by-step procedure for the local worker.
    // The remote model needs the CONSTRAINTS, not the local runbook.
    if (/^\d+\.\s/.test(joined)) return;

    const text = truncateSentence(joined, 220);
    const key = text.toLowerCase().slice(0, 50);
    if (seen.has(key)) return;
    seen.add(key);
    rules.push(text);
  };

  for (const raw of markdown.split('\n')) {
    const line = raw.trim();

    if (line.startsWith('```')) {
      flush();
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    if (line.startsWith('#')) {
      flush();
      heading = line.replace(/^#+\s*/, '');
      continue;
    }
    if (line === '') {
      flush();
      continue;
    }
    // A new bullet starts a new rule.
    if (/^[-*+]\s/.test(line) && paragraph.length > 0) flush();
    paragraph.push(line);
  }
  flush();
  return rules.slice(0, maxRules);
}

/** Trim to a sentence boundary so a rule never ends mid-clause. */
function truncateSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const clipped = text.slice(0, max);
  const stop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('; '));
  return stop > max * 0.5 ? clipped.slice(0, stop + 1) : `${clipped.trimEnd()}…`;
}

export interface PreferenceProviderOptions {
  /** Instruction files to read, most authoritative first. */
  instructionFiles?: string[];
  maxRules?: number;
  /** Static lines always emitted first. */
  preamble?: string[];
}

function expand(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

export class PreferenceContextProvider implements InitialContextProvider {
  readonly id = 'preferences';
  readonly description =
    "The user's standing Claude Code operating rules: host authority, git discipline, coordination and security constraints.";
  readonly priority = 80;
  readonly defaultEnabled = true;

  private readonly files: string[];
  private readonly maxRules: number;
  private readonly preamble: string[];
  private cache?: { rules: string[]; at: number };
  /** Instruction files that exist but could not be read on the last attempt. */
  private unreadable: string[] = [];

  constructor(options: PreferenceProviderOptions | string[] = {}) {
    // Back-compat: an array used to mean "static summary lines".
    const opts: PreferenceProviderOptions = Array.isArray(options) ? { preamble: options } : options;
    this.files = (opts.instructionFiles ?? ['~/CLAUDE.md']).map(expand);
    this.maxRules = opts.maxRules ?? 14;
    this.preamble = opts.preamble ?? [
      'The computer-side worker already loads these same instructions, plus project CLAUDE.md and .claude settings.',
    ];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private async loadRules(): Promise<string[]> {
    // Instructions change rarely; re-reading them on every voice turn is waste.
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.rules;
    // Reset only when actually re-reading. Clearing it on a cache HIT would
    // make the warning disappear for the next minute while the gap it
    // describes is still real.
    this.unreadable = [];

    const collected: string[] = [];
    for (const file of this.files) {
      try {
        const text = await readFile(file, 'utf8');
        collected.push(...extractRules(text, this.maxRules));
      } catch (error) {
        // A MISSING file is normal on a fresh machine. An unreadable one is
        // not, and the two were indistinguishable: both produced a section
        // titled "OPERATING RULES (the worker is bound by these)" with nothing
        // under it, from which the only available conclusion is that the user
        // has no standing rules. These are the constraints the user placed on
        // the worker, so losing them silently is the worst direction to fail
        // in -- the worker proceeds believing it is unconstrained.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          this.unreadable.push(`${file} could not be read (${code ?? 'unknown error'})`);
        }
      }
      if (collected.length >= this.maxRules) break;
    }
    const rules = collected.slice(0, this.maxRules);
    this.cache = { rules, at: Date.now() };
    return rules;
  }

  async getContext(_request: InitialContextRequest): Promise<InitialContextSection> {
    const rules = await this.loadRules();
    // Said in the SECTION, not only in health(). A caller reaches health()
    // through list_context_capabilities; the worker reads this text. If rules
    // are missing because a file could not be read, the text has to say so, or
    // the only reading available is "there are no rules".
    const unreadable = this.unreadable.map((note) => `WARNING: ${note}; any rules it holds are missing here.`);
    return {
      providerId: this.id,
      title: 'OPERATING RULES (the worker is bound by these)',
      lines: [...unreadable, ...(rules.length > 0 ? [...rules, ...this.preamble] : this.preamble)],
      // The first few rules are the ones that prevent damage; never trim to nothing.
      minLines: Math.min(4, rules.length || 1),
      relevance: 0.9,
      generatedAt: new Date().toISOString(),
    };
  }

  async health(): Promise<ProviderHealth> {
    const rules = await this.loadRules();
    if (this.unreadable.length > 0) {
      // Unreadable is a different state from absent, and a worse one.
      return {
        status: 'degraded',
        detail: this.unreadable.join('; '),
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      status: rules.length > 0 ? 'ok' : 'degraded',
      detail: rules.length > 0 ? `${rules.length} rules extracted` : 'no instruction files found',
      checkedAt: new Date().toISOString(),
    };
  }
}
