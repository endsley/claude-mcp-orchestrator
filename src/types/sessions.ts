import type { JsonValue } from './json.js';

export const WORK_SESSION_STATUSES = [
  'starting',
  'working',
  /**
   * A turn finished and the worker is alive, waiting for the next instruction.
   *
   * This exists because the Agent SDK emits a result message at the end of every
   * TURN, not at the end of the conversation. Treating that as "completed" made
   * the session terminal and broke follow-ups like "make it smaller" - the whole
   * point of the system. An idle session still holds its project write lock and
   * still has a resumable Claude conversation.
   */
  'idle',
  'needs_input',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export type WorkSessionStatus = (typeof WORK_SESSION_STATUSES)[number];

export const TERMINAL_WORK_SESSION_STATUSES: readonly WorkSessionStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export function isTerminalStatus(status: WorkSessionStatus): boolean {
  return TERMINAL_WORK_SESSION_STATUSES.includes(status);
}

export type WorkSessionMode = 'work' | 'plan' | 'inspect';

export type PendingRequestType = 'question' | 'approval';

export interface PendingRequest {
  requestId: string;
  workSessionId: string;
  type: PendingRequestType;
  /** The question or the action needing approval, phrased for speech. */
  question: string;
  choices?: string[];
  /** For approvals: the tool the worker wants to run. */
  toolName?: string;
  /** For approvals: redacted summary of the tool input. Never raw secrets. */
  toolSummary?: string;
  /** Permission class that triggered the approval, when applicable. */
  permissionClass?: string;
  createdAt: string;
  answeredAt?: string;
  answer?: string;
  /** True when an approval request was denied. */
  denied?: boolean;
  /** Set when the request expired or was voided by cancellation. */
  voidedAt?: string;
  voidReason?: string;
}

export type ProgressEventKind =
  | 'started'
  | 'step'
  | 'file_changed'
  | 'command'
  | 'test'
  | 'git'
  | 'question'
  | 'approval'
  | 'answer'
  | 'warning'
  | 'error'
  | 'recovered'
  | 'completed'
  | 'cancelled';

export interface ProgressEvent {
  id: number;
  workSessionId: string;
  kind: ProgressEventKind;
  /** Short past-tense sentence, safe to read aloud. */
  message: string;
  /** Structured detail. Already redacted. */
  data?: JsonValue;
  createdAt: string;
}

/**
 * Test outcome.
 *
 * Counts are optional because they can only be reported when they were
 * actually parsed out of the runner's output. `outcome` is derived from the
 * process exit status, which is the only thing we can always trust — claiming
 * "47 passed" when nothing was counted would be a fabrication.
 */
export interface TestSummary {
  /** 'passed'/'failed' come from the exit code; 'unknown' when it was unclear. */
  outcome: 'passed' | 'failed' | 'unknown';
  run?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  /** Command whose exit status established this outcome. */
  command?: string;
  exitCode?: number;
}

export interface GitSummary {
  branch?: string;
  committed: boolean;
  commits?: string[];
  pushed?: boolean;
  dirty?: boolean;
}

export interface Artifact {
  id: string;
  workSessionId: string;
  kind: 'screenshot' | 'html' | 'test-report' | 'log' | 'diff' | 'pdf' | 'image' | 'other';
  title: string;
  /** Absolute path on the worker machine. Never returned to the phone. */
  path: string;
  sizeBytes?: number;
  mimeType?: string;
  createdAt: string;
}

export interface WorkResult {
  status: WorkSessionStatus;
  summary: string;
  filesChanged: string[];
  /** Absent when no test command actually ran. Never fabricated. */
  tests?: TestSummary;
  git?: GitSummary;
  warnings: string[];
  artifacts: Array<Pick<Artifact, 'id' | 'kind' | 'title' | 'sizeBytes'>>;
}

export interface WorkSessionError {
  code: string;
  message: string;
  /** True when the failure came from the worker rather than the orchestrator. */
  fromWorker?: boolean;
}

export interface WorkSession {
  id: string;
  /** Claude Agent SDK session ID, once the worker reports one. */
  claudeSessionId?: string;
  projectId?: string;
  computerId?: string;
  mode: WorkSessionMode;
  /** True when the session may modify files; gates the per-project write lock. */
  writeCapable: boolean;
  status: WorkSessionStatus;
  initialInstruction: string;
  /** Rolling one-line summary of what the worker is doing. */
  currentSummary?: string;
  /** The step in flight, e.g. "Running browser tests." */
  currentStep?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: WorkResult;
  error?: WorkSessionError;
  /** Incremented whenever the worker was reconstructed after a crash/restart. */
  recoveryCount: number;
  /** Set when continuity could not be perfectly preserved. */
  recoveryNote?: string;
  /** Number of instructions sent after the first one. */
  turnCount: number;
}

/** Voice-optimised status payload returned by get_work_session_status. */
export interface WorkSessionStatusView {
  sessionId: string;
  status: WorkSessionStatus;
  summary: string;
  currentStep?: string;
  completedSteps: string[];
  pendingQuestion?: Pick<PendingRequest, 'requestId' | 'type' | 'question' | 'choices'>;
  warnings: string[];
  project?: string;
  computer?: string;
  elapsedSeconds: number;
  recovered: boolean;
}
