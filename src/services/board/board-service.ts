import type { BoardConfig } from '../../config/schema.js';
import type { Logger } from '../../logging/logger.js';
import type { Principal } from '../../security/principal.js';
import { orchestratorError } from '../../types/errors.js';
import type { JsonObject, JsonValue } from '../../types/json.js';
import {
  BOARD_WRITE_OPS,
  BoardRemoteError,
  BoardUnavailableError,
  type BoardClient,
  type BoardOp,
} from './types.js';

export type ClaimKind = 'file' | 'tree' | 'project';
export interface ClaimInput {
  path: string;
  kind: ClaimKind;
}

/** Limits mirrored from the board service, enforced here first. */
export const BOARD_LIMITS = {
  taskChars: 500,
  messageChars: 1000,
  resultChars: 2000,
  claimPathChars: 512,
  claimsPerCall: 50,
} as const;

/**
 * Fixed-window counter per identity. In memory on purpose: a restart clears
 * it, and the map is bounded so a stream of identities cannot grow it.
 */
class IdentityRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private static readonly MAX_KEYS = 10_000;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  take(key: string): boolean {
    const now = this.now();
    const entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.windows.size >= IdentityRateLimiter.MAX_KEYS) {
        for (const [candidate, value] of this.windows) if (value.resetAt <= now) this.windows.delete(candidate);
        if (this.windows.size >= IdentityRateLimiter.MAX_KEYS) return false;
      }
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }
}

/**
 * Normalise and validate one project-relative claim path.
 *
 * The board validates too; this is the first line, and it is stricter: no
 * absolute paths, no `..` segments, no backslashes or control characters.
 */
export function normaliseClaim(claim: ClaimInput): [string, ClaimKind] {
  if (claim.kind === 'project') return ['.', 'project'];
  let path = claim.path.trim();
  if (/[\u0000-\u001f\u007f\\]/.test(path)) {
    throw orchestratorError('INVALID_ARGUMENT', 'claim paths cannot contain control characters or backslashes');
  }
  if (path.startsWith('/') || path.startsWith('~')) {
    throw orchestratorError('INVALID_ARGUMENT', `claim path must be relative to the project root: ${path.slice(0, 80)}`);
  }
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  const segments = path.split('/');
  if (path === '' || path === '.' || segments.includes('..') || segments.includes('.')) {
    throw orchestratorError('INVALID_ARGUMENT', `claim path must name a file or directory inside the project: ${path.slice(0, 80)}`);
  }
  if (path.length > BOARD_LIMITS.claimPathChars) {
    throw orchestratorError('INVALID_ARGUMENT', `claim path is longer than ${BOARD_LIMITS.claimPathChars} characters`);
  }
  return [path, claim.kind];
}

/**
 * The board, as seen by an authenticated outside caller.
 *
 * Every method takes the caller's Principal and builds the payload's `agent`
 * and `session_id` from it. Tool arguments never reach those fields, which is
 * what makes a board write attributable to whoever actually authenticated.
 */
export class BoardService {
  private readonly writes: IdentityRateLimiter;
  private readonly reads: IdentityRateLimiter;

  constructor(
    private readonly client: BoardClient,
    private readonly config: BoardConfig,
    private readonly logger: Logger,
    now: () => number = Date.now,
  ) {
    this.writes = new IdentityRateLimiter(config.writesPerMinute, 60_000, now);
    this.reads = new IdentityRateLimiter(config.readsPerMinute, 60_000, now);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Aliases outside agents may coordinate on. */
  projectAliases(): string[] {
    return Object.keys(this.config.projects).sort();
  }

  private projectRoot(project: string): string {
    const root = this.config.projects[project];
    if (root === undefined) {
      const known = this.projectAliases();
      throw orchestratorError('PROJECT_NOT_FOUND', `"${project.slice(0, 64)}" is not a board project on this server.`, {
        details: { knownProjects: known },
        hint: known.length > 0 ? `Use one of: ${known.join(', ')}.` : 'No board projects are configured.',
      });
    }
    return root;
  }

  private async run(principal: Principal, op: BoardOp, payload: JsonObject): Promise<JsonValue> {
    if (!this.config.enabled) {
      throw orchestratorError('BOARD_UNAVAILABLE', 'The coordination board is not enabled on this server.');
    }
    const limiter = BOARD_WRITE_OPS.has(op) ? this.writes : this.reads;
    if (!limiter.take(principal.board.sessionId)) {
      throw orchestratorError('RATE_LIMITED', 'Too many board requests from this identity. Wait a minute and retry.', {
        retryable: true,
      });
    }
    try {
      const { result } = await this.client.op(op, payload);
      this.logger.info('board op', { op, agent: principal.board.agent, project: payload['project'] ?? null });
      return result;
    } catch (error) {
      if (error instanceof BoardRemoteError) {
        if (error.type === 'ClaimConflict') {
          throw orchestratorError('BOARD_CLAIM_CONFLICT', error.message, {
            details: { conflicts: error.conflicts as unknown as JsonValue },
            hint: 'Another agent holds an overlapping claim. Message them or pick other files.',
          });
        }
        throw orchestratorError('BOARD_REJECTED', error.message, { details: { type: error.type } });
      }
      if (error instanceof BoardUnavailableError) {
        throw orchestratorError('BOARD_UNAVAILABLE', `The coordination board could not be reached: ${error.message}`, {
          retryable: true,
        });
      }
      throw error;
    }
  }

  private identity(principal: Principal): { session_id: string; agent: string } {
    return { session_id: principal.board.sessionId, agent: principal.board.agent };
  }

  async snapshot(principal: Principal, input: { project: string; includeHistory?: boolean }): Promise<JsonValue> {
    return this.run(principal, 'snapshot', {
      project: input.project,
      project_root: this.projectRoot(input.project),
      session_id: principal.board.sessionId,
      include_history: input.includeHistory === true,
      heartbeat: false,
    });
  }

  async postTask(principal: Principal, input: { project: string; task: string; claims: ClaimInput[] }): Promise<JsonValue> {
    return this.run(principal, 'post_task', {
      task: input.task,
      project: input.project,
      project_root: this.projectRoot(input.project),
      ...this.identity(principal),
      cwd: '',
      claims: input.claims.map(normaliseClaim),
      replace_claims: true,
    });
  }

  async claim(principal: Principal, input: { project: string; claims: ClaimInput[]; task?: string }): Promise<JsonValue> {
    return this.run(principal, 'claim', {
      ...(input.task !== undefined ? { task: input.task } : {}),
      project: input.project,
      project_root: this.projectRoot(input.project),
      ...this.identity(principal),
      cwd: '',
      claims: input.claims.map(normaliseClaim),
    });
  }

  async release(principal: Principal, input: { project: string; claims: ClaimInput[] }): Promise<JsonValue> {
    this.projectRoot(input.project);
    return this.run(principal, 'release', {
      project: input.project,
      session_id: principal.board.sessionId,
      claims: input.claims.map(normaliseClaim),
    });
  }

  async heartbeat(principal: Principal, input: { project?: string }): Promise<JsonValue> {
    if (input.project !== undefined) this.projectRoot(input.project);
    return this.run(principal, 'heartbeat', {
      session_id: principal.board.sessionId,
      project: input.project ?? null,
    });
  }

  async message(principal: Principal, input: { project: string; body: string; recipientSessionId?: string }): Promise<JsonValue> {
    this.projectRoot(input.project);
    return this.run(principal, 'message', {
      body: input.body,
      project: input.project,
      ...this.identity(principal),
      recipient_session_id: input.recipientSessionId ?? null,
    });
  }

  async finish(
    principal: Principal,
    input: { project?: string; allProjects?: boolean; result?: string; canceled?: boolean },
  ): Promise<JsonValue> {
    const allProjects = input.allProjects === true;
    if (!allProjects) {
      if (input.project === undefined) {
        throw orchestratorError('INVALID_ARGUMENT', 'Name the project to finish, or set all_projects.');
      }
      this.projectRoot(input.project);
    }
    return this.run(principal, 'finish', {
      session_id: principal.board.sessionId,
      project: allProjects ? null : (input.project ?? null),
      all_projects: allProjects,
      result: input.result ?? null,
      canceled: input.canceled === true,
    });
  }
}
