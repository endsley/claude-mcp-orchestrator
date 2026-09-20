import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino, { type Logger as PinoLogger } from 'pino';
import { redactText, redactValue } from '../security/redaction.js';
import type { JsonValue } from '../types/json.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Context carried on every log line so a voice request can be traced from the
 * MCP tool call down through providers and the Claude worker.
 */
export interface LogContext {
  requestId?: string;
  toolName?: string;
  workSessionId?: string;
  projectId?: string;
  computerId?: string;
  providerId?: string;
  /** Any extra field. Values are deep-redacted before serialisation, so an
   *  arbitrary object (including an Error under `err`) is safe to pass. */
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Derive a logger that stamps `context` onto every subsequent line. */
  child(context: LogContext): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** When set, logs are also written as JSON lines to this file. */
  filePath?: string;
  /** Human-readable output for interactive use. */
  pretty: boolean;
  /**
   * Whether to log the text of user instructions at info level. Off by default:
   * spoken instructions routinely contain things the user would not want on
   * disk, and the session ID is enough to correlate.
   */
  logInstructionText: boolean;
}

function buildPino(options: LoggerOptions): PinoLogger {
  const streams: pino.StreamEntry[] = [];

  if (options.pretty) {
    streams.push({
      level: options.level,
      stream: pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      }) as pino.DestinationStream,
    });
  } else {
    streams.push({ level: options.level, stream: pino.destination({ fd: 2, sync: false }) });
  }

  if (options.filePath) {
    mkdirSync(dirname(options.filePath), { recursive: true });
    streams.push({
      level: options.level,
      stream: pino.destination({ dest: options.filePath, mkdir: true, sync: false }),
    });
  }

  return pino(
    {
      level: options.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      // Defence in depth: even if a call site forgets to redact, pino drops
      // these paths before serialisation.
      redact: {
        paths: [
          'token',
          'authorization',
          '*.token',
          '*.authorization',
          '*.apiKey',
          '*.password',
          '*.secret',
          'headers.authorization',
          'headers.cookie',
        ],
        censor: '[redacted]',
      },
    },
    pino.multistream(streams),
  );
}

class PinoBackedLogger implements Logger {
  constructor(
    private readonly pinoLogger: PinoLogger,
    private readonly bound: LogContext,
  ) {}

  private emit(level: LogLevel, message: string, context?: LogContext): void {
    const merged: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries({ ...this.bound, ...context })) {
      if (value === undefined) continue;
      if (key === 'err') continue;
      merged[key] = redactValue(value);
    }
    if (context && 'err' in context && context.err !== undefined) {
      merged['err'] = redactValue(context.err);
    }
    this.pinoLogger[level](merged, redactText(message));
  }

  debug(message: string, context?: LogContext): void {
    this.emit('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.emit('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.emit('warn', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.emit('error', message, context);
  }
  child(context: LogContext): Logger {
    return new PinoBackedLogger(this.pinoLogger, { ...this.bound, ...context });
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new PinoBackedLogger(buildPino(options), {});
}

/** Logger that discards everything. Used by tests and by `--quiet` tooling. */
export function createNullLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
