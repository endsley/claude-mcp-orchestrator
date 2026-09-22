import { settledWithin } from './settled-within.js';
import { createSdkMcpServer, query, tool, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ClaudeWorkerConfig } from '../../config/schema.js';
import type { Logger } from '../../logging/logger.js';
import { classifyToolCall } from '../../security/permissions.js';
import type { FilesystemScope } from '../../security/paths.js';
import { redactText } from '../../security/redaction.js';
import { OrchestratorError, orchestratorError } from '../../types/errors.js';
import type { PermissionAction, PermissionClass } from '../../types/permissions.js';
import type { GitSummary, ProgressEventKind, TestSummary, WorkSessionMode } from '../../types/sessions.js';
import { AsyncMessageQueue } from './asyncQueue.js';
import { isTestCommand, parseExitCode, summariseTest } from './outcomes.js';

export interface WorkerProgress {
  kind: ProgressEventKind;
  message: string;
  data?: Record<string, unknown>;
}

export interface WorkerCallbacks {
  onSessionId(claudeSessionId: string): void;
  onProgress(progress: WorkerProgress): void;
  /**
   * One turn finished and the worker is now idle, still alive and still holding
   * the conversation. This is NOT the end of the session: the Agent SDK emits a
   * result message per turn, and the query stays open for further instructions.
   */
  onTurnComplete(summary: string): void;
  onError(error: OrchestratorError): void;
  /** Ask the user something and block until answered. */
  askUser(question: string, choices?: string[]): Promise<string>;
  /** Request approval for a classified action. Resolves true when approved. */
  requestApproval(input: {
    question: string;
    toolName: string;
    toolSummary: string;
    permissionClass: PermissionClass;
  }): Promise<boolean>;
}

/**
 * The surface the session manager actually depends on.
 *
 * Depending on this rather than the concrete class is what lets lifecycle
 * tests (continuation, cancellation, recovery, races) run deterministically
 * without spawning a real Claude process per assertion.
 */
export interface WorkerLike {
  readonly accumulator: WorkerAccumulator;
  readonly sessionId: string | undefined;
  readonly isRunning: boolean;
  start(options: WorkerStartOptions): void;
  send(instruction: string): void;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

export interface WorkerStartOptions {
  instruction: string;
  cwd: string;
  /** Claude session ID to resume, when recovering an existing work session. */
  resumeSessionId?: string;
  mode: 'work' | 'plan' | 'inspect';
}

export interface WorkerAccumulator {
  filesChanged: Set<string>;
  tests?: TestSummary;
  git: GitSummary;
  warnings: string[];
  lastAssistantText: string;
}

type PolicyResolver = (permissionClass: PermissionClass) => PermissionAction;

/**
 * Drives one Claude Code conversation through the Agent SDK.
 *
 * The important property is that a single `query()` call stays alive for the
 * whole work session. Follow-up instructions are pushed into its input queue,
 * so "make it smaller" is a new turn in the SAME conversation and Claude still
 * knows what "it" is. Restarting the query per instruction would silently lose
 * that, which is the failure mode this class exists to prevent.
 */
/**
 * How long a graceful interrupt may take before the worker is aborted instead.
 *
 * Deliberately a constant and not a config setting: this commit's sibling
 * deleted a config knob that nothing read, and a second knob nobody will ever
 * tune is the same mistake. Five seconds is long enough for a normal tool call
 * to hand back control and short enough that a human pressing Stop does not
 * wonder whether it worked.
 */
const GRACEFUL_INTERRUPT_MS = 5_000;

export class ClaudeWorker implements WorkerLike {
  private readonly inputQueue = new AsyncMessageQueue<SDKUserMessage>();
  private readonly abortController = new AbortController();
  private query?: Query;
  private consumePromise?: Promise<void>;
  private disposed = false;
  private claudeSessionId?: string;
  /** The mode this session was started in; 'work' is the only writable one. */
  private mode: WorkSessionMode = 'work';

  /** tool_use_id -> what the tool was, so tool results can be interpreted. */
  private readonly inFlightTools = new Map<string, { name: string; input: Record<string, unknown> }>();

  readonly accumulator: WorkerAccumulator = {
    filesChanged: new Set<string>(),
    git: { committed: false },
    warnings: [],
    lastAssistantText: '',
  };

  constructor(
    private readonly workSessionId: string,
    private readonly config: ClaudeWorkerConfig,
    private readonly scope: FilesystemScope,
    private readonly policy: PolicyResolver,
    private readonly callbacks: WorkerCallbacks,
    private readonly logger: Logger,
  ) {}

  get sessionId(): string | undefined {
    return this.claudeSessionId;
  }

  get isRunning(): boolean {
    return this.consumePromise !== undefined && !this.disposed;
  }

  /**
   * Start the conversation. Returns as soon as the query is constructed; the
   * message loop runs in the background so `start_work_session` can acknowledge
   * in milliseconds rather than waiting for the coding job.
   */
  start(options: WorkerStartOptions): void {
    if (this.query) throw orchestratorError('INTERNAL', 'worker already started');

    this.mode = options.mode ?? 'work';

    const sdkOptions: Options = {
      cwd: options.cwd,
      abortController: this.abortController,
      // Loading 'project' is what makes CLAUDE.md apply, so the worker inherits
      // the user's existing Claude Code preferences instead of a second,
      // divergent source of truth.
      settingSources: this.config.settingSources,
      // Never bypassPermissions: canUseTool is the approval boundary.
      // 'inspect' joins 'plan' here. It was getting 'default' -- the same
      // permission mode as a full work session -- so the only thing making an
      // "read-only" session read-only was one sentence of prompt text asking
      // the model nicely. The SDK's plan mode is the enforcement that sentence
      // was standing in for; canUseTool below is the second line.
      permissionMode: options.mode === 'work' ? 'default' : 'plan',
      canUseTool: (toolName, input, opts) => this.handleToolPermission(toolName, input, opts),
      maxTurns: this.config.maxTurns,
      includePartialMessages: false,
      mcpServers: { orchestrator: this.buildAskUserServer() },
      stderr: (data: string) => {
        this.logger.debug('worker stderr', { workSessionId: this.workSessionId, data: redactText(data).slice(0, 500) });
      },
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.executablePath ? { pathToClaudeCodeExecutable: this.config.executablePath } : {}),
      ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
    };

    this.query = query({ prompt: this.inputQueue, options: sdkOptions });
    this.send(options.instruction);
    this.consumePromise = this.consume().catch((error: unknown) => {
      this.callbacks.onError(this.toOrchestratorError(error));
    });
  }

  /** Push another instruction into the live conversation. */
  send(instruction: string): void {
    if (this.disposed) {
      throw orchestratorError('SESSION_ALREADY_FINISHED', 'worker has been disposed');
    }
    this.inputQueue.push({
      type: 'user',
      message: { role: 'user', content: instruction },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  /**
   * Ask Claude to stop what it is doing. Graceful: the SDK's interrupt lets the
   * model finish its current tool call and return control, which is far better
   * than killing a process mid-write.
   */
  async interrupt(): Promise<void> {
    if (!this.query) return;
    let failed = false;
    const attempt = this.query.interrupt().catch((error: unknown) => {
      failed = true;
      this.logger.warn('graceful interrupt failed; falling back to abort', {
        workSessionId: this.workSessionId,
        err: error,
      });
    });

    // Bounded, because graceful is not a stop if it can wait forever. The SDK
    // interrupt lets the model finish its current tool call; a tool call that
    // never returns made the user's Stop never return either.
    const returned = await settledWithin(attempt, GRACEFUL_INTERRUPT_MS);
    if (!returned) {
      this.logger.warn('graceful interrupt did not return in time; aborting', {
        workSessionId: this.workSessionId,
        timeoutMs: GRACEFUL_INTERRUPT_MS,
      });
    }
    if (failed || !returned) this.abortController.abort();
  }

  /** Terminate the worker and release its resources. */
  /**
   * Shut the worker down and release its child process.
   *
   * What this covers, and what it does not, because the difference matters and
   * was raised as a possible process leak.
   *
   * Covered: every graceful path. The input queue closes, the abort controller
   * signals the SDK, and the consume loop is awaited so the child exits before
   * this resolves. SessionManager calls it on failure, cancellation, timeout
   * reaping and shutdown.
   *
   * NOT covered by this method: the orchestrator being SIGKILLed. An
   * AbortController only signals in-process machinery, so a `kill -9` of the
   * main PID cannot run any of this, and on restart recoverOnStartup can only
   * dispose workers it finds in its own (now empty) map.
   *
   * That case is handled by the deployment rather than by code. The unit runs
   * with systemd's default KillMode=control-group, so every `claude` child
   * lives in the service cgroup and is torn down with it - on stop, on
   * restart, and when Restart=on-failure cycles the unit after a crash.
   * Measured rather than assumed: after 24 restarts in one evening, including
   * ones that reported interrupted sessions, there were zero surviving
   * orchestrator workers on the host.
   *
   * The consequence to remember: running `node dist/index.js` by hand, outside
   * systemd, loses that safety net entirely. A SIGKILL there really does leave
   * reparented `claude` processes holding their pipes. Do not add a PID-file
   * reaper for the systemd case; it is already covered.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.inputQueue.close();
    try {
      this.abortController.abort();
    } catch {
      // Aborting an already-finished controller is not an error worth raising.
    }
    if (this.consumePromise) {
      await this.consumePromise.catch(() => undefined);
    }
  }

  // ------------------------------------------------------------- permissions

  private async handleToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; blockedPath?: string },
  ): Promise<PermissionResult> {
    // Our own ask_user tool is the mechanism for talking to the user; gating it
    // behind an approval would deadlock the conversation.
    if (toolName.startsWith('mcp__orchestrator__')) {
      return { behavior: 'allow', updatedInput: input };
    }

    const classification = classifyToolCall({
      toolName,
      input,
      scope: this.scope,
      // The classifier cannot enforce read-only without being told. This is
      // the second line of defence behind the SDK's plan permission mode:
      // canUseTool is OUR boundary and should not depend on the SDK honouring
      // a mode we asked for.
      writeCapable: this.mode === 'work',
      ...(opts.blockedPath ? { blockedPath: opts.blockedPath } : {}),
    });
    const action = this.policy(classification.class);

    this.logger.debug('tool permission decision', {
      workSessionId: this.workSessionId,
      toolName,
      permissionClass: classification.class,
      action,
    });

    if (action === 'allow') return { behavior: 'allow', updatedInput: input };

    if (action === 'deny') {
      this.callbacks.onProgress({
        kind: 'warning',
        message: `Blocked ${toolName}: ${classification.reason}.`,
        data: { toolName, permissionClass: classification.class },
      });
      return {
        behavior: 'deny',
        message: `Denied by orchestrator policy (${classification.class}): ${classification.reason}`,
      };
    }

    try {
      const approved = await this.callbacks.requestApproval({
        question: `${classification.summary}. This is classified ${classification.class} because ${classification.reason}. Allow it?`,
        toolName,
        toolSummary: classification.summary,
        permissionClass: classification.class,
      });
      if (approved) return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: 'The user declined this action.' };
    } catch (error) {
      // A timed-out or abandoned approval must fail closed.
      this.logger.warn('approval request failed; denying', {
        workSessionId: this.workSessionId,
        toolName,
        err: error,
      });
      return {
        behavior: 'deny',
        message: 'No approval was received for this action, so it was not performed.',
      };
    }
  }

  /**
   * In-process MCP server giving the worker one tool: ask the user a question.
   * This is how "there are two navigation components, which one?" reaches the
   * phone instead of Claude guessing.
   */
  private buildAskUserServer(): NonNullable<Options['mcpServers']>[string] {
    return createSdkMcpServer({
      name: 'orchestrator',
      version: '1.0.0',
      instructions:
        'Use ask_user when a decision genuinely requires the user: an ambiguous target, a ' +
        'missing requirement, or a choice between incompatible approaches. The user is on a ' +
        'phone using voice, so ask one short question at a time and offer concrete choices.',
      tools: [
        tool(
          'ask_user',
          'Ask the user a clarifying question and wait for their spoken answer.',
          {
            question: z.string().min(1).describe('One short question, phrased for speech.'),
            choices: z
              .array(z.string())
              .optional()
              .describe('Optional list of concrete options for the user to pick from.'),
          },
          async (args) => {
            const answer = await this.callbacks.askUser(args.question, args.choices);
            return { content: [{ type: 'text' as const, text: answer }] };
          },
        ),
      ],
    });
  }

  // ----------------------------------------------------------- message loop

  private async consume(): Promise<void> {
    if (!this.query) return;
    try {
      for await (const message of this.query) {
        this.handleMessage(message);
      }
    } catch (error) {
      if (this.disposed || this.abortController.signal.aborted) return;
      throw error;
    }
  }

  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.claudeSessionId = message.session_id;
          this.callbacks.onSessionId(message.session_id);
        }
        break;

      case 'assistant':
        this.handleAssistant(message);
        break;

      case 'user':
        this.handleToolResult(message);
        break;

      case 'result':
        this.handleResult(message);
        break;

      default:
        break;
    }
  }

  private handleAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): void {
    const content = message.message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      // Thinking blocks are internal reasoning and must never leave this process.
      if (block.type === 'text' && typeof block.text === 'string') {
        this.accumulator.lastAssistantText = block.text;
      } else if (block.type === 'tool_use') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        this.inFlightTools.set(block.id, { name: block.name, input });
        this.recordToolUse(block.name, input);
      }
    }
  }

  private recordToolUse(toolName: string, input: Record<string, unknown>): void {
    const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : undefined;

    if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') && filePath) {
      this.accumulator.filesChanged.add(filePath);
      this.callbacks.onProgress({
        kind: 'file_changed',
        message: `Edited ${shortPath(filePath)}.`,
        data: { path: filePath, tool: toolName },
      });
      return;
    }

    if (toolName === 'Bash') {
      const command = typeof input['command'] === 'string' ? input['command'] : '';
      const label = typeof input['description'] === 'string' ? input['description'] : summariseCommand(command);
      this.callbacks.onProgress({
        kind: isTestCommand(command) ? 'test' : 'command',
        message: label,
        data: { command: redactText(command).slice(0, 300) },
      });
      if (/\bgit\b[^|;]*\bcommit\b/.test(command)) this.accumulator.git.committed = true;
      if (/\bgit\b[^|;]*\bpush\b/.test(command)) this.accumulator.git.pushed = true;
      return;
    }

    if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
      // Too noisy to report individually; they show up as the current step only.
      this.callbacks.onProgress({
        kind: 'step',
        message: filePath ? `Reading ${shortPath(filePath)}.` : `Searching the project.`,
      });
    }
  }

  private handleToolResult(message: Extract<SDKMessage, { type: 'user' }>): void {
    const content = message.message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const pending = this.inFlightTools.get(block.tool_use_id);
      if (!pending) continue;
      this.inFlightTools.delete(block.tool_use_id);

      const text = extractResultText(block.content);

      if (pending.name === 'Bash') {
        const command = typeof pending.input['command'] === 'string' ? pending.input['command'] : '';
        const exitCode = block.is_error ? (parseExitCode(text) ?? 1) : (parseExitCode(text) ?? 0);

        if (isTestCommand(command)) {
          // Only recorded because a test command actually completed and we saw
          // its exit status. Never synthesised from the model's prose.
          this.accumulator.tests = summariseTest(command, text, exitCode);
          this.callbacks.onProgress({
            kind: 'test',
            message:
              this.accumulator.tests.outcome === 'passed'
                ? `Tests passed${this.accumulator.tests.run !== undefined ? ` (${this.accumulator.tests.run})` : ''}.`
                : `Tests failed.`,
            data: { command: redactText(command).slice(0, 200), exitCode },
          });
        }

        if (/\bgit\b[^|;]*\bbranch\b|\bgit\b[^|;]*\brev-parse\b|\bgit\s+status\b/.test(command)) {
          const branch = parseBranch(text);
          if (branch) this.accumulator.git.branch = branch;
        }
      }

      if (block.is_error) {
        this.accumulator.warnings.push(`${pending.name} failed: ${redactText(text).slice(0, 200)}`);
      }
    }
  }

  private handleResult(message: Extract<SDKMessage, { type: 'result' }>): void {
    if (message.subtype === 'success') {
      const summary = this.accumulator.lastAssistantText.trim() || 'Work completed.';
      this.callbacks.onTurnComplete(summary);
      return;
    }
    this.callbacks.onError(
      orchestratorError('CLAUDE_WORKER_FAILED', `Claude worker ended with "${message.subtype}"`, {
        details: { subtype: message.subtype },
      }),
    );
  }

  private toOrchestratorError(error: unknown): OrchestratorError {
    if (OrchestratorError.is(error)) return error;
    const message = error instanceof Error ? error.message : String(error);
    return orchestratorError('CLAUDE_WORKER_FAILED', redactText(message), { cause: error });
  }
}

// ------------------------------------------------------------------ helpers

function shortPath(path: string): string {
  const parts = path.split('/');
  return parts.slice(-2).join('/');
}

function summariseCommand(command: string): string {
  const first = command.trim().split(/\s+/).slice(0, 3).join(' ');
  return `Running ${redactText(first)}.`;
}

function parseBranch(text: string): string | undefined {
  const onBranch = /On branch (\S+)/.exec(text);
  if (onBranch?.[1]) return onBranch[1];
  const trimmed = text.trim();
  if (/^[\w.\-/]+$/.test(trimmed) && trimmed.length < 100) return trimmed;
  return undefined;
}

function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'object' && block !== null && 'text' in block
          ? String((block as { text: unknown }).text)
          : '',
      )
      .join('\n');
  }
  return '';
}
