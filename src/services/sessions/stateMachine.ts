import { orchestratorError } from '../../types/errors.js';
import { type WorkSessionStatus, isTerminalStatus } from '../../types/sessions.js';

/**
 * Work-session state machine.
 *
 * Scattered booleans are how session bugs hide, so status is a single value and
 * every change goes through {@link assertTransition}. The table below is the
 * whole truth about legal movement; anything absent is a bug, not a corner case.
 */
const ALLOWED_TRANSITIONS: Record<WorkSessionStatus, readonly WorkSessionStatus[]> = {
  starting: ['working', 'idle', 'failed', 'cancelled', 'interrupted'],
  working: ['idle', 'needs_input', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'interrupted'],
  // `idle` is the normal resting state between turns: the worker is alive and a
  // follow-up instruction simply resumes it.
  idle: ['working', 'needs_input', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'interrupted'],
  needs_input: ['working', 'idle', 'failed', 'cancelled', 'interrupted'],
  awaiting_approval: ['working', 'idle', 'failed', 'cancelled', 'interrupted'],
  // `interrupted` is recoverable: a follow-up instruction or a successful
  // resume puts the session back to work. The three genuinely terminal states
  // below accept nothing.
  interrupted: ['working', 'idle', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: WorkSessionStatus, to: WorkSessionStatus): boolean {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Throw unless the transition is legal.
 *
 * Terminal states get a distinct error code because "you cancelled something
 * that already finished" is a normal race in a voice UI — the user says "stop"
 * just as the work lands — and the phone should say so rather than report a
 * generic failure.
 */
export function assertTransition(
  sessionId: string,
  from: WorkSessionStatus,
  to: WorkSessionStatus,
): void {
  if (canTransition(from, to)) return;

  if (isTerminalStatus(from)) {
    throw orchestratorError(
      'SESSION_ALREADY_FINISHED',
      `work session ${sessionId} already finished with status "${from}" and cannot move to "${to}"`,
      { details: { sessionId, from, to }, hint: 'Start a new work session instead.' },
    );
  }
  throw orchestratorError(
    'INVALID_STATE_TRANSITION',
    `work session ${sessionId} cannot move from "${from}" to "${to}"`,
    { details: { sessionId, from, to } },
  );
}

/** Statuses in which the session will accept a new instruction from the user. */
export function acceptsInstruction(status: WorkSessionStatus): boolean {
  return (
    status === 'working' ||
    status === 'idle' ||
    status === 'needs_input' ||
    status === 'awaiting_approval' ||
    status === 'interrupted'
  );
}

/** Statuses in which a worker process should be running. */
export function expectsLiveWorker(status: WorkSessionStatus): boolean {
  return (
    status === 'starting' ||
    status === 'working' ||
    status === 'idle' ||
    status === 'needs_input' ||
    status === 'awaiting_approval'
  );
}

export { ALLOWED_TRANSITIONS };
