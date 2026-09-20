import { describe, expect, it } from 'vitest';
import { OrchestratorError } from '../../../src/types/errors.js';
import { WORK_SESSION_STATUSES, isTerminalStatus } from '../../../src/types/sessions.js';
import { acceptsInstruction, assertTransition, canTransition, expectsLiveWorker } from '../../../src/services/sessions/stateMachine.js';

describe('work session state machine', () => {
  it('allows the documented happy path', () => {
    expect(canTransition('starting', 'working')).toBe(true);
    expect(canTransition('working', 'needs_input')).toBe(true);
    expect(canTransition('needs_input', 'working')).toBe(true);
    expect(canTransition('working', 'awaiting_approval')).toBe(true);
    expect(canTransition('awaiting_approval', 'working')).toBe(true);
    expect(canTransition('working', 'completed')).toBe(true);
    expect(canTransition('working', 'failed')).toBe(true);
    expect(canTransition('working', 'cancelled')).toBe(true);
    expect(canTransition('working', 'interrupted')).toBe(true);
  });

  it('treats a no-op transition as legal', () => {
    for (const status of WORK_SESSION_STATUSES) {
      expect(canTransition(status, status)).toBe(true);
    }
  });

  it('refuses to move out of a terminal state', () => {
    for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
      expect(isTerminalStatus(terminal)).toBe(true);
      expect(canTransition(terminal, 'working')).toBe(false);
    }
  });

  it('allows an interrupted session to resume', () => {
    expect(canTransition('interrupted', 'working')).toBe(true);
  });

  /**
   * `idle` is the resting state between turns. It must NOT behave like a
   * terminal state: the Agent SDK emits a result per turn, and treating that as
   * the end of the session made every follow-up instruction fail.
   */
  describe('idle (between turns)', () => {
    it('is reachable from working and is not terminal', () => {
      expect(canTransition('working', 'idle')).toBe(true);
      expect(isTerminalStatus('idle')).toBe(false);
    });

    it('resumes into working on a new instruction', () => {
      expect(canTransition('idle', 'working')).toBe(true);
      expect(acceptsInstruction('idle')).toBe(true);
    });

    it('still implies a live worker', () => {
      expect(expectsLiveWorker('idle')).toBe(true);
    });

    it('can still be completed, cancelled or fail', () => {
      expect(canTransition('idle', 'completed')).toBe(true);
      expect(canTransition('idle', 'cancelled')).toBe(true);
      expect(canTransition('idle', 'failed')).toBe(true);
    });

    it('can ask a question directly from idle', () => {
      expect(canTransition('idle', 'needs_input')).toBe(true);
    });
  });

  it('rejects skipping straight from starting to completed', () => {
    expect(canTransition('starting', 'completed')).toBe(false);
  });

  it('throws SESSION_ALREADY_FINISHED for terminal sources', () => {
    try {
      assertTransition('ws_1', 'completed', 'working');
      throw new Error('should have thrown');
    } catch (error) {
      expect(OrchestratorError.is(error)).toBe(true);
      expect((error as OrchestratorError).code).toBe('SESSION_ALREADY_FINISHED');
    }
  });

  it('throws INVALID_STATE_TRANSITION for illegal non-terminal moves', () => {
    try {
      assertTransition('ws_1', 'starting', 'completed');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as OrchestratorError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('knows which states accept a new instruction', () => {
    expect(acceptsInstruction('working')).toBe(true);
    expect(acceptsInstruction('needs_input')).toBe(true);
    expect(acceptsInstruction('interrupted')).toBe(true);
    expect(acceptsInstruction('completed')).toBe(false);
    expect(acceptsInstruction('cancelled')).toBe(false);
  });

  it('knows which states imply a live worker', () => {
    expect(expectsLiveWorker('working')).toBe(true);
    expect(expectsLiveWorker('interrupted')).toBe(false);
    expect(expectsLiveWorker('completed')).toBe(false);
  });
});
