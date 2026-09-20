/**
 * Push-driven async iterable.
 *
 * The Agent SDK's streaming-input mode takes an `AsyncIterable<SDKUserMessage>`
 * that must stay open for the life of the session. This queue is what lets a
 * later `send_work_session_instruction` call push a message into a generator
 * that was created minutes earlier — which is exactly what makes "make it
 * smaller" land in the SAME Claude conversation rather than a new one.
 */
export class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  private failure: unknown;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  /** Close the stream after draining anything already buffered. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  /** Close with an error delivered to the consumer. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pending(): number {
    return this.buffer.length;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
        continue;
      }
      if (this.closed) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      yield next.value;
    }
  }
}
