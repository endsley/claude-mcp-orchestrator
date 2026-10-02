import type { JsonObject, JsonValue } from '../../src/types/json.js';
import type { BoardClient, BoardOp, BoardOpResult } from '../../src/services/board/types.js';

/**
 * In-memory stand-in for the network board service.
 *
 * Records every operation and payload exactly as the orchestrator sent it,
 * which is what the identity tests inspect, and keeps just enough state for
 * post/claim/snapshot/finish to behave plausibly.
 */
export class FakeBoardClient implements BoardClient {
  readonly calls: Array<{ op: BoardOp; payload: JsonObject }> = [];
  /** When set, the next op throws this instead of running. */
  failNext: Error | undefined;
  private readonly items = new Map<string, JsonObject>();
  private messageId = 0;

  async op(op: BoardOp, payload: JsonObject): Promise<BoardOpResult> {
    this.calls.push({ op, payload: structuredClone(payload) });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    const key = `${String(payload['project'])}|${String(payload['session_id'])}`;
    const toClaims = (value: JsonValue | undefined): JsonObject[] =>
      Array.isArray(value) ? value.map((pair) => ({ path: (pair as JsonValue[])[0] ?? '', kind: (pair as JsonValue[])[1] ?? '' })) : [];

    switch (op) {
      case 'post_task':
      case 'claim': {
        const previous = this.items.get(key);
        const claims = op === 'claim' && previous ? [...(previous['claims'] as JsonObject[]), ...toClaims(payload['claims'])] : toClaims(payload['claims']);
        const item: JsonObject = {
          project: payload['project'] ?? null,
          // The real board returns these; the tools must strip them.
          project_root: payload['project_root'] ?? null,
          cwd: payload['cwd'] ?? null,
          session_id: payload['session_id'] ?? null,
          agent: payload['agent'] ?? null,
          task: (payload['task'] as string | undefined) || (previous?.['task'] ?? ''),
          status: 'active',
          claims,
        };
        this.items.set(key, item);
        return { result: item, node: 'fake', epoch: 1 };
      }
      case 'snapshot':
        return {
          result: {
            project: payload['project'] ?? null,
            work_items: [...this.items.values()].filter((item) => item['project'] === payload['project']),
            messages: [],
            stale_after_seconds: 14400,
          },
        };
      case 'message':
        this.messageId += 1;
        return { result: this.messageId };
      case 'finish':
        return { result: this.items.delete(key) };
      case 'release':
      case 'heartbeat':
        return { result: 1 };
      default:
        return { result: null };
    }
  }

  lastPayload(op: BoardOp): JsonObject | undefined {
    return [...this.calls].reverse().find((call) => call.op === op)?.payload;
  }
}
