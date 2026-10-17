import type { AgentcoordCaller, AgentcoordOp, AgentcoordTransport } from '../../src/services/board/agentcoord-client.js';
import type { JsonObject, JsonValue } from '../../src/types/json.js';

/**
 * In-memory stand-in for the Agent Coordination service.
 *
 * `agents` maps a credential to the agent id the service would resolve it
 * to, as an agent credential does. Every call is recorded with the caller
 * exactly as sent, which is what the identity tests inspect. Replies include
 * fields the orchestrator must NOT pass on (checkouts, worker keys, message
 * payloads), so the allowlist tests have something to catch.
 */
export class FakeAgentcoord implements AgentcoordTransport {
  readonly calls: Array<{ op: AgentcoordOp; payload: JsonObject; caller: AgentcoordCaller }> = [];
  /** Per-op reply override (a value, or a function of the payload), or an error to throw. */
  readonly replies = new Map<AgentcoordOp, JsonValue | ((payload: JsonObject) => JsonValue) | Error>();

  constructor(readonly agents: Record<string, string> = {}) {}

  private agentOf(caller: AgentcoordCaller): string {
    const agent = this.agents[caller.token];
    if (agent === undefined) throw new Error('fake agentcoord: unknown credential');
    return agent;
  }

  async call(op: AgentcoordOp, payload: JsonObject, caller: AgentcoordCaller): Promise<JsonValue> {
    this.calls.push({ op, payload: structuredClone(payload), caller: { ...caller } });
    const agent = this.agentOf(caller);
    const override = this.replies.get(op);
    if (override instanceof Error) throw override;
    if (typeof override === 'function') return override(payload);
    if (override !== undefined) return override;
    const worker = caller.session;
    const claim = (path: string, project = String(payload['project'])) => ({
      id: 1,
      project,
      host: 'ext',
      agent,
      worker_key: `${worker}:muse`,
      worker,
      holder: `${agent}#${worker}`,
      task: 'fix x',
      path,
      kind: 'file',
      checkout: '/home/chieh/code/secret-checkout',
      claimed_at: '2026-10-17T00:00:00Z',
      heartbeat_at: '2026-10-17T00:00:00Z',
      expires_at: '2026-10-17T04:00:00Z',
      read_only: false,
    });
    switch (op) {
      case 'file_board':
        return {
          project: (payload['project'] as string | undefined) ?? null,
          agent,
          worker,
          you: `${agent}#${worker}`,
          lease_seconds: 14400,
          holders: [
            {
              project: payload['project'] ?? 'oakhaven',
              host: 'katie',
              agent: 'katie/claude-ui',
              worker: 'abc',
              holder: 'katie/claude-ui#abc',
              task: 'ui work',
              stale: false,
              checkout: '/home/chieh/code/oakhaven',
              since: '2026-10-17T00:00:00Z',
              expires_at: '2026-10-17T04:00:00Z',
              claims: [{ path: 'src/ui.ts', kind: 'file' }],
            },
          ],
          stale: [],
          mine: [claim('src/a.ts'), claim('other.ts', 'not-allowed')],
        };
      case 'file_claim':
        return {
          project: payload['project'] ?? null,
          host: 'ext',
          agent,
          worker,
          holder: `${agent}#${worker}`,
          task: payload['task'] ?? 'fix x',
          claimed: payload['claims'] ?? [],
          replaced: [],
          claims: [claim('src/a.ts')],
          job: null,
          ack_jobs: [],
          read_only: false,
        };
      case 'file_release':
        return { project: payload['project'] ?? null, released: payload['paths'] ?? [], not_held: [], claims: [] };
      case 'file_finish':
        return { released: [{ project: 'oakhaven', worker, path: 'src/a.ts' }], count: 1, all_sessions: false };
      case 'heartbeat':
        return { extended_claims: [], jobs: [12], file_claims: 2 };
      case 'send':
        return { id: 77, duplicate: false, recipients: 1, warnings: [] };
      case 'attention':
        return {
          messages: [
            { id: 5, sender: 'katie/claude-ui', kind: 'discussion', subject: 's', body: 'hello', payload: { secret: '/home/x' }, truncated: false },
          ],
          tasks: [],
          waiting_on: [],
          more: false,
          next_check_seconds: 0,
        };
      case 'ack':
        return { acknowledged: payload['ids'] ?? [] };
      case 'read':
        return { id: payload['id'] ?? null, sender: 'katie/claude-ui', kind: 'discussion', body: 'full text', payload: { x: 1 }, audience: { to: [agent] } };
      case 'project_show':
        return {
          project: { name: payload['project'] ?? null, repo: 'endsley/iamar', vision: 'v', status: 'active', updated_by: 'katie/claude' },
          jobs: [
            { id: 11, project: payload['project'] ?? null, title: 'simple job', kind: 'code-simple', status: 'todo', files: ['oakhaven:src/a.ts'], role: 'internal-role', task_id: 3 },
            { id: 12, project: payload['project'] ?? null, title: 'done job', kind: 'code', status: 'done', files: [] },
          ],
          next_open: 11,
          decisions: [{ id: 1, text: 'internal decision' }],
        };
      case 'job_take':
        return { job: { id: payload['id'] ?? null, project: 'oakhaven', status: 'in_progress', owner: agent }, took_over_from: null, ack_jobs: [], claim_conflicts: [], warnings: ['declare files'] };
      case 'job_update':
        return { job: { id: payload['id'] ?? null, project: 'oakhaven', status: payload['action'] === 'done' ? 'done' : 'in_progress', owner: agent } };
      case 'my_jobs':
        return {
          jobs: [
            { id: 11, project: 'oakhaven', title: 'simple job', status: 'in_progress', note: null },
            { id: 99, project: 'not-allowed', title: 'elsewhere', status: 'in_progress', note: null },
          ],
          closed_by_others: [],
          closed_hours: 24,
        };
      default:
        return null;
    }
  }

  last(op: AgentcoordOp): { payload: JsonObject; caller: AgentcoordCaller } | undefined {
    return [...this.calls].reverse().find((call) => call.op === op);
  }
}
