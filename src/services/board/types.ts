import type { JsonObject, JsonValue } from '../../types/json.js';

/**
 * The network code coordination board, as this server sees it.
 *
 * The real implementation (HttpBoardClient) talks to the network board
 * service; tests use an in-memory fake. Payloads are already fully resolved
 * by the caller - project alias, project root, the caller's session id and
 * agent name, and project-relative claims - so a client never interprets them.
 */
export const BOARD_OPS = [
  'post_task',
  'claim',
  'release',
  'heartbeat',
  'finish',
  'message',
  'snapshot',
  'active_claims',
  'details',
  'announced',
] as const;
export type BoardOp = (typeof BOARD_OPS)[number];

export const BOARD_WRITE_OPS: ReadonlySet<BoardOp> = new Set(['post_task', 'claim', 'release', 'heartbeat', 'finish', 'message']);

export interface BoardOpResult {
  result: JsonValue;
  /** Node that answered, and the epoch it reported. */
  node?: string;
  epoch?: number;
}

export interface BoardClient {
  op(op: BoardOp, payload: JsonObject, signal?: AbortSignal): Promise<BoardOpResult>;
}

/** One live claim another agent holds that blocked ours. */
export interface BoardConflict {
  path: string;
  kind: string;
  session_id?: string;
  agent?: string;
  task?: string;
}

/** The board ran the operation and rejected it (HTTP 422). */
export class BoardRemoteError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly conflicts: BoardConflict[] = [],
  ) {
    super(message);
    this.name = 'BoardRemoteError';
  }
}

/** No board node accepted the operation. */
export class BoardUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardUnavailableError';
  }
}
