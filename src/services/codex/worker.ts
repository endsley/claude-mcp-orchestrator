import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { CodexWorkerConfig } from '../../config/schema.js';
import type { Logger } from '../../logging/logger.js';
import { orchestratorError } from '../../types/errors.js';
import { redactText } from '../../security/redaction.js';
import { isTestCommand, summariseTest } from '../claude/outcomes.js';
import type {
  WorkerAccumulator,
  WorkerCallbacks,
  WorkerLike,
  WorkerStartOptions,
} from '../claude/worker.js';

const GRACEFUL_INTERRUPT_MS = 5_000;
const MAX_STDERR_CHARS = 4_000;
const MAX_JSON_LINE_CHARS = 1_000_000;
type CodexChild = ChildProcessByStdio<null, Readable, Readable>;

type CodexItem = {
  type?: string;
  text?: unknown;
  command?: unknown;
  exit_code?: unknown;
  aggregated_output?: unknown;
  changes?: unknown;
};

type CodexEvent = {
  type?: string;
  thread_id?: unknown;
  message?: unknown;
  error?: unknown;
  item?: CodexItem;
};

/**
 * One durable Codex work session.
 *
 * `codex exec` finishes a child process for each turn. This worker therefore
 * serializes prompts and resumes the saved thread in a fresh child for every
 * follow-up, while presenting the same session contract as Claude Code.
 */
export class CodexWorker implements WorkerLike {
  private readonly pendingInstructions: string[] = [];
  private child?: CodexChild;
  private draining = false;
  private disposed = false;
  private interrupted = false;
  private started = false;
  private cwd = '';
  private codexThreadId?: string;

  readonly accumulator: WorkerAccumulator = {
    filesChanged: new Set<string>(),
    git: { committed: false },
    warnings: [],
    lastAssistantText: '',
  };

  constructor(
    private readonly workSessionId: string,
    private readonly config: CodexWorkerConfig,
    private readonly callbacks: WorkerCallbacks,
    private readonly logger: Logger,
  ) {}

  get sessionId(): string | undefined {
    return this.codexThreadId;
  }

  /** A completed Codex child remains resumable through its saved thread id. */
  get isRunning(): boolean {
    return this.started && !this.disposed;
  }

  start(options: WorkerStartOptions): void {
    if (this.started) throw orchestratorError('INTERNAL', 'Codex worker already started');
    this.started = true;
    this.cwd = options.cwd;
    this.codexThreadId = options.resumeSessionId;
    this.enqueue(options.instruction);
  }

  send(instruction: string): void {
    if (this.disposed) throw orchestratorError('SESSION_ALREADY_FINISHED', 'Codex worker has been disposed');
    if (!this.started) throw orchestratorError('INTERNAL', 'Codex worker has not been started');
    this.enqueue(instruction);
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.pendingInstructions.length = 0;
    const child = this.child;
    if (!child || child.exitCode !== null) return;

    this.killProcessGroup(child, 'SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => child.once('close', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, GRACEFUL_INTERRUPT_MS)),
    ]);
    if (child.exitCode === null) this.killProcessGroup(child, 'SIGKILL');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.interrupt();
  }

  private enqueue(instruction: string): void {
    this.pendingInstructions.push(instruction);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      while (!this.disposed && !this.interrupted && this.pendingInstructions.length > 0) {
        const instruction = this.pendingInstructions.shift();
        if (instruction === undefined) continue;
        try {
          const summary = await this.runTurn(instruction);
          if (!this.disposed && !this.interrupted) this.callbacks.onTurnComplete(summary);
        } catch (error) {
          if (!this.disposed && !this.interrupted) {
            const message = error instanceof Error ? error.message : String(error);
            this.callbacks.onError(orchestratorError('CODEX_WORKER_FAILED', redactText(message), { cause: error }));
          }
          this.pendingInstructions.length = 0;
          return;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTurn(instruction: string): Promise<string> {
    const executable = this.config.executablePath ?? 'codex';
    const child = spawn(executable, this.commandArgs(instruction), {
      cwd: this.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    let stderr = '';
    let stdoutBuffer = '';
    let finalMessage = '';
    let streamError = '';
    let streamOverflow = false;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > MAX_JSON_LINE_CHARS) {
          streamOverflow = true;
          continue;
        }
        const text = line.trim();
        if (text !== '') {
          const consumed = this.consumeEvent(text, finalMessage);
          finalMessage = consumed.finalMessage;
          streamError = consumed.streamError || streamError;
        }
      }
      if (stdoutBuffer.length > MAX_JSON_LINE_CHARS) {
        streamOverflow = true;
        stdoutBuffer = '';
      }
    });

    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (this.child === child) this.child = undefined;
    const tail = stdoutBuffer.trim();
    if (tail !== '') {
      const consumed = this.consumeEvent(tail, finalMessage);
      finalMessage = consumed.finalMessage;
      streamError = consumed.streamError || streamError;
    }
    if (streamOverflow) throw new Error('Codex emitted an oversized JSON event');
    if (this.disposed || this.interrupted) throw new Error('Codex work was cancelled');
    if (streamError) throw new Error(streamError);
    if (outcome.code !== 0) {
      const detail = stderr.trim() || (outcome.signal ? `terminated by ${outcome.signal}` : 'no diagnostic output');
      throw new Error(`Codex exited with code ${outcome.code ?? 'unknown'}: ${detail}`);
    }
    const summary = finalMessage.trim() || 'Codex completed the turn.';
    this.accumulator.lastAssistantText = summary;
    return summary;
  }

  private commandArgs(instruction: string): string[] {
    const args = ['exec'];
    if (this.codexThreadId) {
      args.push('resume', '--json');
    } else {
      args.push('--json', '--cd', this.cwd);
    }
    // MCP work sessions are non-interactive. Match Katie's established Codex
    // automation alias so a delegated job cannot block indefinitely waiting for
    // a terminal approval nobody can answer through the MCP session protocol.
    args.push('--dangerously-bypass-approvals-and-sandbox');
    if (this.config.model) args.push('--model', this.config.model);
    if (this.codexThreadId) args.push(this.codexThreadId);
    args.push(instruction);
    return args;
  }

  private consumeEvent(line: string, finalMessage: string): { finalMessage: string; streamError?: string } {
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      this.logger.debug('ignored non-JSON Codex output', { workSessionId: this.workSessionId });
      return { finalMessage };
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id !== '') {
      this.codexThreadId = event.thread_id;
      this.callbacks.onSessionId(event.thread_id);
      return { finalMessage };
    }
    if (event.type === 'turn.started') {
      this.callbacks.onProgress({ kind: 'step', message: 'Codex is working.' });
      return { finalMessage };
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      return { finalMessage, streamError: codexEventError(event) || 'Codex reported a failed turn.' };
    }

    const item = event.item;
    if (!item) return { finalMessage };
    if (event.type === 'item.started' && item.type === 'command_execution') {
      this.callbacks.onProgress({ kind: 'command', message: `Running ${shortCommand(text(item.command))}.` });
      return { finalMessage };
    }
    if (event.type === 'item.completed' && item.type === 'command_execution') {
      const command = text(item.command);
      const output = text(item.aggregated_output);
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
      const test = isTestCommand(command);
      if (test) this.accumulator.tests = summariseTest(command, output, exitCode);
      const outcome = exitCode === undefined || exitCode === 0 ? 'Finished' : 'Command failed';
      this.callbacks.onProgress({ kind: test ? 'test' : 'command', message: `${outcome}: ${shortCommand(command)}.` });
      return { finalMessage };
    }
    if (event.type === 'item.completed' && item.type === 'file_change') {
      for (const path of changedPaths(item.changes)) {
        this.accumulator.filesChanged.add(path);
        this.callbacks.onProgress({ kind: 'file_changed', message: `Changed ${shortPath(path)}.` });
      }
      return { finalMessage };
    }
    if (event.type === 'item.completed' && item.type === 'agent_message') {
      const message = text(item.text).trim();
      return { finalMessage: message || finalMessage };
    }
    return { finalMessage };
  }

  private killProcessGroup(child: CodexChild, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The process already exited between the two checks.
      }
    }
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function codexEventError(event: CodexEvent): string {
  const direct = text(event.message).trim();
  if (direct !== '') return direct;
  if (!event.error || typeof event.error !== 'object') return '';
  return text((event.error as Record<string, unknown>)['message']).trim();
}

function shortCommand(command: string): string {
  const first = command.trim().split(/\s+/).slice(0, 3).join(' ');
  return redactText(first || 'command');
}

function shortPath(path: string): string {
  return path.split('/').slice(-2).join('/');
}

function changedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((change) => {
    if (!change || typeof change !== 'object') return [];
    const path = (change as Record<string, unknown>)['path'];
    return typeof path === 'string' && path !== '' ? [path] : [];
  });
}
