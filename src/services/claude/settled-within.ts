/**
 * Whether a promise settles within a deadline.
 *
 * This exists because "graceful" is not a stop unless it is bounded. The
 * worker's interrupt asks the SDK to let the model finish its current tool
 * call, which is the right thing to want and an unbounded wait in practice: a
 * tool call that never returns makes the user's Stop never return either, and
 * Stop is the control they reach for precisely BECAUSE something is stuck.
 *
 * It is a separate module because the SDK's `query` is imported directly and
 * cannot be faked, so the worker itself is untestable here. The logic lives
 * where it can be tested; the worker keeps only the one-line call.
 *
 * Two details that are the whole point:
 *  - the timer is always cleared, so a fast settle cannot leave a handle
 *    holding the event loop open;
 *  - a rejection is swallowed, including one that arrives AFTER the deadline
 *    has already been reported. Without that, a late failure on an abandoned
 *    promise becomes an unhandled rejection and can take the process down.
 */
export async function settledWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  // Attached immediately, not inside the race: the rejection must be handled
  // even on the path where the race has already resolved to false.
  const guarded = work.then(
    () => true,
    () => true,
  );

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([guarded, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
