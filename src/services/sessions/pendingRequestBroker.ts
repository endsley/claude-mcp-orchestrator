import { orchestratorError } from '../../types/errors.js';
import type { PendingRequest, PendingRequestType } from '../../types/sessions.js';
import type { WorkSessionStore } from './sessionStore.js';

interface Waiter {
  resolve: (answer: { answer: string; denied: boolean }) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface AskInput {
  workSessionId: string;
  type: PendingRequestType;
  question: string;
  choices?: string[];
  toolName?: string;
  toolSummary?: string;
  permissionClass?: string;
  timeoutMs: number;
}

/**
 * Bridges "the worker is blocked on a question" to "the phone answered it".
 *
 * The durable record lives in SQLite so a restart can still show the question;
 * the in-memory promise is what actually unblocks the worker. If the process
 * restarts, the waiter is gone but the row is not, which is why
 * {@link PendingRequestBroker.isWaiting} exists — a request nobody is waiting
 * on has to be treated as unanswerable rather than silently accepted.
 */
export class PendingRequestBroker {
  private readonly waiters = new Map<string, Waiter>();

  constructor(private readonly store: WorkSessionStore) {}

  /**
   * Create a pending request and block until answered, denied, or timed out.
   * The returned promise never resolves twice.
   */
  async ask(input: AskInput): Promise<{ answer: string; denied: boolean; request: PendingRequest }> {
    const request = this.store.createPendingRequest({
      workSessionId: input.workSessionId,
      type: input.type,
      question: input.question,
      ...(input.choices ? { choices: input.choices } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.toolSummary ? { toolSummary: input.toolSummary } : {}),
      ...(input.permissionClass ? { permissionClass: input.permissionClass } : {}),
    });

    const outcome = await new Promise<{ answer: string; denied: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(request.requestId);
        this.store.voidOpenRequests(input.workSessionId, 'timed out waiting for an answer');
        reject(
          orchestratorError(
            'APPROVAL_REQUIRED',
            `no answer received for "${input.question}" within ${Math.round(input.timeoutMs / 1000)}s`,
            { details: { requestId: request.requestId }, retryable: true },
          ),
        );
      }, input.timeoutMs);
      // Do not hold the event loop open purely to wait for a human.
      timer.unref?.();
      this.waiters.set(request.requestId, { resolve, reject, timer });
    });

    return { ...outcome, request };
  }

  /**
   * Deliver an answer. Records it durably first, so a crash between the write
   * and the resolve leaves evidence the question was answered.
   */
  answer(requestId: string, answer: string, denied = false): PendingRequest {
    const updated = this.store.answerPendingRequest(requestId, answer, denied);
    const waiter = this.waiters.get(requestId);
    if (waiter) {
      this.waiters.delete(requestId);
      clearTimeout(waiter.timer);
      waiter.resolve({ answer, denied });
    }
    return updated;
  }

  /** True when a live worker is actually blocked on this request. */
  isWaiting(requestId: string): boolean {
    return this.waiters.has(requestId);
  }

  /** Abandon every waiter for a session, e.g. on cancellation. */
  abandonSession(workSessionId: string, reason: string): void {
    this.store.voidOpenRequests(workSessionId, reason);
    for (const [requestId, waiter] of this.waiters) {
      const request = this.store.getPendingRequest(requestId);
      if (request?.workSessionId !== workSessionId) continue;
      this.waiters.delete(requestId);
      clearTimeout(waiter.timer);
      waiter.reject(
        orchestratorError('SESSION_ALREADY_FINISHED', `work session ${workSessionId} ${reason}`, {
          details: { requestId, workSessionId },
        }),
      );
    }
  }

  get waiterCount(): number {
    return this.waiters.size;
  }
}
