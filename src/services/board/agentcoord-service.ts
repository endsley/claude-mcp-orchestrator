import { createHash } from 'node:crypto';
import type { AgentcoordIdentityConfig, BoardConfig } from '../../config/schema.js';
import type { Logger } from '../../logging/logger.js';
import type { Principal } from '../../security/principal.js';
import { orchestratorError } from '../../types/errors.js';
import type { JsonObject, JsonValue } from '../../types/json.js';
import {
  AGENTCOORD_READ_OPS,
  AgentcoordRemoteError,
  type AgentcoordCaller,
  type AgentcoordOp,
  type AgentcoordTransport,
} from './agentcoord-client.js';
import { IdentityRateLimiter, normaliseClaim, type ClaimInput } from './board-service.js';
import { BoardUnavailableError } from './types.js';

/**
 * The board tools, backed by the Agent Coordination service (agentcoord).
 *
 * Mapping (the same as agent-coordination agentcoord/mcp_server.py):
 *
 *   code_coordination_board  -> file_board
 *   post_code_task           -> file_claim (replace)
 *   claim_code_files         -> file_claim
 *   release_code_files       -> file_release
 *   heartbeat_code_task      -> heartbeat
 *   message_code_agents      -> send
 *   finish_code_task         -> file_finish (this worker only)
 *   coord_*                  -> attention, ack, read, project_show, job_take,
 *                               job_update, my_jobs
 *
 * Identity: every call is made with the caller's OWN agentcoord agent
 * credential, chosen from config by the authenticated Principal (board key
 * name or OAuth client_id). Tool arguments never reach the credential, the
 * session/worker id or the engine. A principal with no configured identity
 * is refused - there is no shared fallback credential.
 *
 * Output: every result passes an ALLOWLIST before it leaves (public* below).
 * agentcoord rows carry host-side checkouts and other agents' internals; a
 * field the service adds later stays hidden until it is listed here.
 */

export const COORD_LIMITS = {
  taskChars: 500,
  messageChars: 4000,
  noteChars: 2000,
  claimsPerCall: 50,
  ackIdsPerCall: 100,
} as const;

export type JobAction = 'progress' | 'block' | 'done' | 'release';

/** Reads the identity's credential file; undefined when absent or empty. */
export type TokenReader = (path: string) => Promise<string | undefined>;

interface ResolvedIdentity {
  config: AgentcoordIdentityConfig;
  caller: AgentcoordCaller;
}

const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------- allowlists

function asObject(value: JsonValue | undefined): JsonObject {
  return (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as JsonObject;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function pick(source: JsonObject, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

const CLAIM_FIELDS = ['path', 'kind', 'read_only'] as const;
const HOLDER_FIELDS = ['project', 'agent', 'worker', 'holder', 'task', 'stale', 'since', 'expires_at'] as const;
const MY_CLAIM_FIELDS = [
  'project', 'agent', 'worker', 'holder', 'task', 'path', 'kind', 'read_only', 'claimed_at', 'heartbeat_at', 'expires_at',
] as const;
const CONFLICT_FIELDS = ['requested', 'path', 'kind', 'agent', 'worker', 'holder', 'task', 'claimed_at', 'expires_at'] as const;
const MESSAGE_FIELDS = [
  'id', 'sender', 'kind', 'subject', 'body', 'task_id', 'reply_to', 'requires_ack', 'created_at', 'first_seen', 'truncated',
] as const;
const ATTENTION_TASK_FIELDS = ['id', 'title', 'status', 'requester', 'claim_expires', 'deadline', 'why'] as const;
const WAITING_FIELDS = ['agent', 'state', 'seen_ago_s', 'warning'] as const;
const PROJECT_FIELDS = ['name', 'repo', 'vision', 'status', 'created_at', 'updated_at'] as const;
const JOB_FIELDS = [
  'id', 'project', 'position', 'title', 'details', 'kind', 'status', 'owner', 'owner_since', 'owner_heartbeat',
  'owner_stale', 'note', 'updated_at', 'done_at', 'files', 'read_files', 'closed_by', 'closed_reason',
] as const;
const MY_JOB_FIELDS = ['id', 'project', 'title', 'status', 'note', 'owner_since', 'closed_by', 'closed_reason', 'done_at'] as const;

const publicClaims = (value: JsonValue | undefined): JsonValue[] =>
  asArray(value).map((claim) => pick(asObject(claim), CLAIM_FIELDS));

function publicHolder(value: JsonValue): JsonObject {
  const holder = asObject(value);
  return { ...pick(holder, HOLDER_FIELDS), claims: publicClaims(holder['claims']) };
}

export function publicConflicts(value: JsonValue | undefined): JsonValue[] {
  return asArray(value).map((row) => pick(asObject(row), CONFLICT_FIELDS));
}

export function publicMessage(value: JsonValue | undefined): JsonObject {
  return pick(asObject(value), MESSAGE_FIELDS);
}

export function publicJob(value: JsonValue | undefined): JsonObject {
  return pick(asObject(value), JOB_FIELDS);
}

// ---------------------------------------------------------------- service

export class AgentcoordBoardService {
  private readonly writes: IdentityRateLimiter;
  private readonly reads: IdentityRateLimiter;
  /** agent id -> fingerprint of the credential last confirmed to be that agent. */
  private readonly verified = new Map<string, string>();
  private readonly allowed: ReadonlySet<string>;

  constructor(
    private readonly transport: AgentcoordTransport,
    private readonly config: BoardConfig,
    private readonly readToken: TokenReader,
    private readonly logger: Logger,
    now: () => number = Date.now,
  ) {
    this.writes = new IdentityRateLimiter(config.writesPerMinute, 60_000, now);
    this.reads = new IdentityRateLimiter(config.readsPerMinute, 60_000, now);
    this.allowed = new Set(config.agentcoord.projects);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Projects outside agents may reach. */
  projectNames(): string[] {
    return [...this.allowed].sort();
  }

  private requireProject(project: string): string {
    if (!this.allowed.has(project)) {
      const known = this.projectNames();
      throw orchestratorError('PROJECT_NOT_FOUND', `"${project.slice(0, 64)}" is not a coordination project on this server.`, {
        details: { knownProjects: known },
        hint: known.length > 0 ? `Use one of: ${known.join(', ')}.` : 'No coordination projects are configured.',
      });
    }
    return project;
  }

  /** The configured identity for this principal, or a refusal. Fails closed. */
  identityConfig(principal: Principal): AgentcoordIdentityConfig {
    const { boardKeys, oauthClients } = this.config.agentcoord.identities;
    const table = principal.kind === 'board-key' ? boardKeys : principal.kind === 'oauth' ? oauthClients : undefined;
    // Object.hasOwn: a subject such as "__proto__" or "constructor" must not
    // resolve to an inherited property.
    const entry = table !== undefined && Object.hasOwn(table, principal.subject) ? table[principal.subject] : undefined;
    if (entry === undefined) {
      const what =
        principal.kind === 'board-key'
          ? `board key "${principal.subject}"`
          : principal.kind === 'oauth'
            ? `OAuth client ${principal.subject}`
            : 'this owner credential';
      throw orchestratorError('PERMISSION_DENIED', `No Agent Coordination identity is configured for ${what}.`, {
        hint: 'Ask the owner to map this credential to an ext/<name> agent under board.agentcoord.identities.',
      });
    }
    return entry;
  }

  private async resolve(principal: Principal): Promise<ResolvedIdentity> {
    const config = this.identityConfig(principal);
    const token = await this.readToken(config.tokenFile);
    if (!token) {
      // The path is the owner's filesystem layout: log it, never return it.
      this.logger.warn('agentcoord credential not readable', { agent: config.agent, tokenFile: config.tokenFile });
      throw orchestratorError('BOARD_UNAVAILABLE', `The Agent Coordination credential for ${config.agent} is not installed on this server.`);
    }
    const caller: AgentcoordCaller = { token, session: principal.board.sessionId };
    if (config.engine !== undefined) caller.engine = config.engine;
    return { config, caller };
  }

  /**
   * Confirm once per credential that it really is the configured agent, so
   * a token file holding another ext/ agent's credential cannot silently act
   * as that agent. file_board reports the caller's agent id and is a read.
   */
  private async verify(identity: ResolvedIdentity): Promise<void> {
    const fingerprint = createHash('sha256').update(identity.caller.token).digest('hex');
    if (this.verified.get(identity.config.agent) === fingerprint) return;
    const first = this.projectNames()[0];
    const result = asObject(await this.transport.call('file_board', first !== undefined ? { project: first } : {}, identity.caller));
    if (result['agent'] !== identity.config.agent) {
      this.logger.error('agentcoord credential is for a different agent', {
        expected: identity.config.agent,
        actual: typeof result['agent'] === 'string' ? result['agent'] : null,
      });
      throw orchestratorError('PERMISSION_DENIED', `The Agent Coordination credential installed for ${identity.config.agent} belongs to another agent.`, {
        hint: 'The owner must install the credential created for this agent.',
      });
    }
    this.verified.set(identity.config.agent, fingerprint);
  }

  private async run(principal: Principal, op: AgentcoordOp, payload: JsonObject): Promise<JsonObject> {
    if (!this.config.enabled) {
      throw orchestratorError('BOARD_UNAVAILABLE', 'The coordination board is not enabled on this server.');
    }
    const identity = await this.resolve(principal);
    const limiter = AGENTCOORD_READ_OPS.has(op) ? this.reads : this.writes;
    if (!limiter.take(principal.board.sessionId)) {
      throw orchestratorError('RATE_LIMITED', 'Too many coordination requests from this identity. Wait a minute and retry.', {
        retryable: true,
      });
    }
    try {
      await this.verify(identity);
      const result = await this.transport.call(op, payload, identity.caller);
      this.logger.info('agentcoord op', { op, agent: identity.config.agent, project: payload['project'] ?? null });
      return asObject(result);
    } catch (error) {
      throw this.translate(error, identity.config.agent);
    }
  }

  private translate(error: unknown, agent: string): unknown {
    if (error instanceof AgentcoordRemoteError) {
      const hint = error.fix !== undefined ? { hint: error.fix } : {};
      if (error.type === 'conflict' && Array.isArray(error.detail['conflicts'])) {
        return orchestratorError('BOARD_CLAIM_CONFLICT', error.message, {
          details: { conflicts: publicConflicts(error.detail['conflicts']) },
          ...hint,
        });
      }
      if (error.status === 401) {
        this.logger.error('agentcoord refused this server\'s credential', { agent, type: error.type });
        return orchestratorError('BOARD_UNAVAILABLE', `Agent Coordination refused the credential installed for ${agent}.`, {
          hint: 'The owner must install a valid agent credential for this identity.',
        });
      }
      if (error.status === 403) {
        // Includes work-kind routing ("ext/muse may only take code-simple work").
        return orchestratorError('PERMISSION_DENIED', error.message, hint);
      }
      if (error.status === 503) {
        return orchestratorError('BOARD_UNAVAILABLE', `Agent Coordination failed mid-operation: ${error.message}`, {
          retryable: true,
          hint: error.fix ?? 'Read the current state before repeating a write.',
        });
      }
      return orchestratorError('BOARD_REJECTED', error.message, { details: { type: error.type }, ...hint });
    }
    if (error instanceof BoardUnavailableError) {
      return orchestratorError('BOARD_UNAVAILABLE', `Agent Coordination could not be reached: ${error.message}`, { retryable: true });
    }
    return error;
  }

  /** Legacy claim shape -> agentcoord {path, kind}; "project" is the tree ".". */
  private claims(input: ClaimInput[]): JsonObject[] {
    return input.map((claim) => {
      const [path, kind] = normaliseClaim(claim);
      return kind === 'project' ? { path: '.', kind: 'tree' } : { path, kind };
    });
  }

  private requireClaims(input: ClaimInput[]): JsonObject[] {
    if (input.length === 0) {
      throw orchestratorError('INVALID_ARGUMENT', 'Name at least one file or directory you will edit.');
    }
    return this.claims(input);
  }

  // ---- the seven board tools

  async board(principal: Principal, input: { project: string; includeHistory?: boolean }): Promise<JsonObject> {
    const project = this.requireProject(input.project);
    const result = await this.run(principal, 'file_board', { project });
    return {
      project,
      you: result['you'] ?? null,
      lease_seconds: result['lease_seconds'] ?? null,
      holders: asArray(result['holders']).map(publicHolder),
      ...(input.includeHistory === true ? { stale: asArray(result['stale']).map(publicHolder) } : {}),
      // file_board lists the caller's claims in every project; show this one.
      mine: asArray(result['mine'])
        .map((row) => asObject(row))
        .filter((row) => row['project'] === project)
        .map((row) => pick(row, MY_CLAIM_FIELDS)),
    };
  }

  private publicClaimResult(result: JsonObject): JsonObject {
    return {
      ...pick(result, ['project', 'agent', 'worker', 'holder', 'task', 'job', 'ack_jobs', 'read_only', 'replaced']),
      claimed: publicClaims(result['claimed']),
      claims: asArray(result['claims']).map((row) => pick(asObject(row), MY_CLAIM_FIELDS)),
    };
  }

  async postTask(principal: Principal, input: { project: string; task: string; claims: ClaimInput[] }): Promise<JsonObject> {
    const project = this.requireProject(input.project);
    const claims = this.requireClaims(input.claims);
    return this.publicClaimResult(await this.run(principal, 'file_claim', { project, task: input.task, replace: true, claims }));
  }

  async claim(
    principal: Principal,
    input: { project: string; claims: ClaimInput[]; task?: string; job?: number; ackJobs?: number[]; readOnly?: boolean },
  ): Promise<JsonObject> {
    const project = this.requireProject(input.project);
    const payload: JsonObject = { project, claims: this.requireClaims(input.claims) };
    if (input.task !== undefined) payload['task'] = input.task;
    if (input.job !== undefined) payload['job'] = input.job;
    if (input.ackJobs !== undefined && input.ackJobs.length > 0) payload['ack_jobs'] = input.ackJobs;
    if (input.readOnly === true) payload['read_only'] = true;
    return this.publicClaimResult(await this.run(principal, 'file_claim', payload));
  }

  async release(principal: Principal, input: { project: string; claims: ClaimInput[] }): Promise<JsonObject> {
    const project = this.requireProject(input.project);
    const paths = this.requireClaims(input.claims).map((claim) => claim['path'] as string);
    const result = await this.run(principal, 'file_release', { project, paths });
    return {
      project,
      released: asArray(result['released']),
      not_held: asArray(result['not_held']),
      claims: asArray(result['claims']).map((row) => pick(asObject(row), MY_CLAIM_FIELDS)),
    };
  }

  async heartbeat(principal: Principal, input: { project?: string }): Promise<JsonObject> {
    if (input.project !== undefined) this.requireProject(input.project);
    // agentcoord heartbeats every claim and job of this worker at once.
    const result = await this.run(principal, 'heartbeat', {});
    return {
      file_claims: typeof result['file_claims'] === 'number' ? result['file_claims'] : 0,
      jobs: asArray(result['jobs']),
      tasks: asArray(result['extended_claims']),
    };
  }

  async message(principal: Principal, input: { project: string; body: string; to?: string }): Promise<JsonObject> {
    const project = this.requireProject(input.project);
    if (input.to !== undefined && !AGENT_ID.test(input.to)) {
      throw orchestratorError('INVALID_ARGUMENT', 'Address a message to an agent id such as "katie/claude-ui" (host/name).');
    }
    const payload: JsonObject = { body: input.body, kind: 'discussion', subject: `[${project}] code coordination` };
    if (input.to !== undefined) payload['to'] = [input.to];
    else payload['group'] = 'all';
    const result = await this.run(principal, 'send', payload);
    return pick(result, ['id', 'recipients', 'duplicate', 'warnings']);
  }

  async finish(
    principal: Principal,
    input: { project?: string; allProjects?: boolean; result?: string; canceled?: boolean },
  ): Promise<JsonObject> {
    const allProjects = input.allProjects === true;
    if (!allProjects) {
      if (input.project === undefined) {
        throw orchestratorError('INVALID_ARGUMENT', 'Name the project to finish, or set all_projects.');
      }
      this.requireProject(input.project);
    }
    const note = input.result?.trim() || (input.canceled === true ? 'canceled' : undefined);
    // Never `all`: that would release every worker of the agent, not just this one.
    const payload: JsonObject = { project: allProjects ? null : (input.project ?? null) };
    if (note !== undefined) payload['note'] = note;
    const result = await this.run(principal, 'file_finish', payload);
    return {
      count: typeof result['count'] === 'number' ? result['count'] : 0,
      released: asArray(result['released']).map((row) => pick(asObject(row), ['project', 'path'])),
    };
  }

  // ---- agentcoord work tools

  async attention(principal: Principal, input: { limit?: number }): Promise<JsonObject> {
    const result = await this.run(principal, 'attention', input.limit !== undefined ? { limit: input.limit } : {});
    return {
      messages: asArray(result['messages']).map(publicMessage),
      tasks: asArray(result['tasks']).map((row) => pick(asObject(row), ATTENTION_TASK_FIELDS)),
      waiting_on: asArray(result['waiting_on']).map((row) => pick(asObject(row), WAITING_FIELDS)),
      more: result['more'] === true,
      next_check_seconds: typeof result['next_check_seconds'] === 'number' ? result['next_check_seconds'] : null,
      note: 'Fetching is not acknowledging: coord_ack each message once you have handled it.',
    };
  }

  async ack(principal: Principal, input: { ids: number[]; applied?: string }): Promise<JsonObject> {
    const payload: JsonObject = { ids: input.ids };
    if (input.applied !== undefined) payload['applied'] = input.applied;
    const result = await this.run(principal, 'ack', payload);
    return { acknowledged: asArray(result['acknowledged']) };
  }

  async read(principal: Principal, input: { id: number }): Promise<JsonObject> {
    return publicMessage(await this.run(principal, 'read', { id: input.id }));
  }

  /**
   * The reachable projects, with progress counts and whether each is a vision
   * swarm (its vision starts with "VISION SWARM"). Only allowlisted projects
   * are returned; the rest of the board's projects stay invisible.
   */
  async projectList(principal: Principal, input: { swarmsOnly?: boolean; includeDone?: boolean } = {}): Promise<JsonObject> {
    const payload: JsonObject = {};
    if (input.includeDone === true) payload['include_done'] = true;
    const result = await this.run(principal, 'project_list', payload);
    const projects = asArray(result['projects'])
      .map(asObject)
      .filter((row) => typeof row['name'] === 'string' && this.allowed.has(row['name'] as string))
      .map((row) => {
        const vision = typeof row['vision'] === 'string' ? (row['vision'] as string) : '';
        const out: JsonObject = pick(row, ['name', 'repo', 'status', 'done', 'open', 'in_progress', 'blocked', 'updated_at']);
        out['swarm'] = vision.trimStart().toUpperCase().startsWith('VISION SWARM');
        out['vision_preview'] = vision.slice(0, 200);
        return out;
      })
      .filter((row) => input.swarmsOnly !== true || row['swarm'] === true);
    return { projects };
  }

  async projectShow(principal: Principal, input: { project: string; includeDone?: boolean }): Promise<JsonObject> {
    const project = this.requireProject(input.project);
    const result = await this.run(principal, 'project_show', { project });
    const jobs = asArray(result['jobs']).map(publicJob);
    const done = jobs.filter((job) => job['status'] === 'done');
    return {
      project: pick(asObject(result['project']), PROJECT_FIELDS),
      jobs: input.includeDone === true ? jobs : jobs.filter((job) => job['status'] !== 'done'),
      done_count: done.length,
      next_open: result['next_open'] ?? null,
    };
  }

  async jobTake(principal: Principal, input: { project: string; id: number; note?: string }): Promise<JsonObject> {
    const project = this.requireProject(input.project);
    // A job is named by id alone, and ids span every project: confirm this
    // one is in the reachable project before taking it.
    const plan = await this.run(principal, 'project_show', { project });
    const inPlan = asArray(plan['jobs']).some((job) => asObject(job)['id'] === input.id);
    if (!inPlan) {
      throw orchestratorError('INVALID_ARGUMENT', `Job ${input.id} is not a job of project ${project}.`, {
        hint: 'Read coord_project_show for the job ids of a project.',
      });
    }
    const payload: JsonObject = { id: input.id };
    if (input.note !== undefined) payload['note'] = input.note;
    const result = await this.run(principal, 'job_take', payload);
    return {
      job: publicJob(result['job']),
      took_over_from: result['took_over_from'] ?? null,
      ack_jobs: asArray(result['ack_jobs']),
      claim_conflicts: publicConflicts(result['claim_conflicts']),
      warnings: asArray(result['warnings']).filter((warning) => typeof warning === 'string'),
    };
  }

  async jobUpdate(principal: Principal, input: { id: number; action: JobAction; note?: string }): Promise<JsonObject> {
    if ((input.action === 'block' || input.action === 'done') && !input.note?.trim()) {
      throw orchestratorError(
        'INVALID_ARGUMENT',
        input.action === 'block' ? 'Say what blocks the job (note).' : 'Say what was finished and how it was verified (note).',
      );
    }
    // Only the caller's own open jobs, and only in reachable projects.
    const mine = await this.run(principal, 'my_jobs', {});
    const job = asArray(mine['jobs']).map(asObject).find((row) => row['id'] === input.id);
    if (job === undefined || typeof job['project'] !== 'string' || !this.allowed.has(job['project'])) {
      throw orchestratorError('PERMISSION_DENIED', `Job ${input.id} is not one of your open jobs in a reachable project.`, {
        hint: 'Take it first with coord_job_take; coord_my_jobs lists the jobs you hold.',
      });
    }
    const payload: JsonObject = { id: input.id, action: input.action };
    if (input.note !== undefined) payload['note'] = input.note;
    const result = await this.run(principal, 'job_update', payload);
    return { job: publicJob(result['job']) };
  }

  async myJobs(principal: Principal): Promise<JsonObject> {
    const result = await this.run(principal, 'my_jobs', {});
    const reachable = (row: JsonValue): boolean => {
      const project = asObject(row)['project'];
      return typeof project === 'string' && this.allowed.has(project);
    };
    return {
      jobs: asArray(result['jobs']).filter(reachable).map((row) => pick(asObject(row), MY_JOB_FIELDS)),
      closed_by_others: asArray(result['closed_by_others']).filter(reachable).map((row) => pick(asObject(row), MY_JOB_FIELDS)),
    };
  }
}
