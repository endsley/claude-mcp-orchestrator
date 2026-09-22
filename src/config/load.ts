import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { orchestratorError } from '../types/errors.js';
import { BUILT_IN_CONTEXT_PROFILES } from './defaults.js';
import { appConfigSchema, type AppConfig } from './schema.js';

export interface LoadConfigOptions {
  /** Explicit config file. When absent, the standard locations are searched. */
  configPath?: string;
  /** Base directory that relative paths in config resolve against. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LoadedConfig {
  config: AppConfig;
  /** Absolute path of the file that was loaded, or null when using defaults. */
  sourcePath: string | null;
  /** Non-fatal notes, e.g. "config file not found, using defaults". */
  warnings: string[];
}

const CONFIG_FILENAMES = ['config/orchestrator.yaml', 'config/orchestrator.yml', 'orchestrator.yaml'];

/** Expand a leading `~` and make the path absolute against `base`. */
export function expandPath(value: string, base: string): string {
  let expanded = value;
  if (expanded === '~') expanded = homedir();
  else if (expanded.startsWith('~/')) expanded = resolve(homedir(), expanded.slice(2));
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

function findConfigFile(cwd: string, explicit?: string): string | null {
  if (explicit) {
    const path = expandPath(explicit, cwd);
    if (!existsSync(path)) {
      throw orchestratorError('INVALID_CONFIG', `config file not found: ${path}`);
    }
    return path;
  }
  for (const candidate of CONFIG_FILENAMES) {
    const path = resolve(cwd, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Parse a `KEY=VALUE` env file.
 *
 * Deliberately minimal: no interpolation, no command substitution, no `export`
 * evaluation. The file may hold live credentials, so the parser must not be
 * able to do anything other than produce strings.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load a `.env` file sitting next to the config, if present.
 *
 * Values already exported in the real environment always win, so a systemd
 * `EnvironmentFile` or an operator's shell export cannot be silently overridden
 * by a stale file in the working directory.
 */
function loadDotEnv(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = [];
  const path = resolve(cwd, '.env');
  if (!existsSync(path)) return warnings;
  try {
    for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, 'utf8')))) {
      if (env[key] === undefined) env[key] = value;
    }
  } catch {
    warnings.push('.env exists but could not be read; continuing without it');
  }
  return warnings;
}

/**
 * Resolve Mem0 settings that must not be committed.
 *
 * Precedence: explicit YAML > process environment > `memory.envFile`. The env
 * file is read late and only for MEM0_* keys, so pointing at a shared file
 * cannot smuggle unrelated settings into the config.
 */
function resolveMemoryEnv(raw: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string): string[] {
  const warnings: string[] = [];
  const memory = (raw['memory'] ??= {}) as Record<string, unknown>;

  let fileEnv: Record<string, string> = {};
  const envFile = typeof memory['envFile'] === 'string' ? memory['envFile'] : undefined;
  if (envFile) {
    const path = expandPath(envFile, cwd);
    if (existsSync(path)) {
      try {
        fileEnv = parseEnvFile(readFileSync(path, 'utf8'));
      } catch {
        warnings.push(`memory.envFile ${path} could not be read; continuing without it`);
      }
    } else {
      warnings.push(`memory.envFile ${path} does not exist; continuing without it`);
    }
  }

  // Populate process env for the keys the memory provider reads, without
  // clobbering anything the operator already exported.
  for (const key of ['MEM0_API_KEY', 'MEM0_USER_ID', 'MEM0_BASE_URL']) {
    const fromFile = fileEnv[key];
    if (fromFile !== undefined && env[key] === undefined) env[key] = fromFile;
  }

  if (memory['baseUrl'] === undefined) {
    const baseUrl = env['MCP_ORCHESTRATOR_MEM0_BASE_URL'] ?? env['MEM0_BASE_URL'];
    if (baseUrl !== undefined && baseUrl !== '') memory['baseUrl'] = baseUrl;
  }
  return warnings;
}

/**
 * Environment overrides for the handful of settings that differ per deployment
 * or that must not live in a file. Kept intentionally small: config files are
 * the primary interface, and a sprawling env surface is hard to audit.
 */
function applyEnvOverrides(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = [];
  const server = (raw['server'] ??= {}) as Record<string, unknown>;

  if (env['MCP_ORCHESTRATOR_HOST']) server['host'] = env['MCP_ORCHESTRATOR_HOST'];
  if (env['MCP_ORCHESTRATOR_PORT']) {
    const port = Number.parseInt(env['MCP_ORCHESTRATOR_PORT'], 10);
    if (Number.isNaN(port)) warnings.push('MCP_ORCHESTRATOR_PORT is not a number; ignored');
    else server['port'] = port;
  }
  if (env['MCP_ORCHESTRATOR_AUTH_MODE']) {
    const auth = (server['auth'] ??= {}) as Record<string, unknown>;
    auth['mode'] = env['MCP_ORCHESTRATOR_AUTH_MODE'];
  }
  if (env['MCP_ORCHESTRATOR_LOG_LEVEL']) {
    const logging = (raw['logging'] ??= {}) as Record<string, unknown>;
    logging['level'] = env['MCP_ORCHESTRATOR_LOG_LEVEL'];
  }
  if (env['MCP_ORCHESTRATOR_DB_PATH']) {
    const database = (raw['database'] ??= {}) as Record<string, unknown>;
    database['path'] = env['MCP_ORCHESTRATOR_DB_PATH'];
  }
  return warnings;
}

function mergeBuiltInProfiles(config: AppConfig): AppConfig {
  const merged = { ...BUILT_IN_CONTEXT_PROFILES, ...config.contextProfiles };
  return { ...config, contextProfiles: merged };
}

/** Resolve every path-valued setting to an absolute path exactly once. */
function absolutisePaths(config: AppConfig, base: string): AppConfig {
  return {
    ...config,
    database: { ...config.database, path: expandPath(config.database.path, base) },
    logging: {
      ...config.logging,
      ...(config.logging.filePath ? { filePath: expandPath(config.logging.filePath, base) } : {}),
    },
    projects: {
      ...config.projects,
      roots: config.projects.roots.map((root) => expandPath(root, base)),
      metadata: Object.fromEntries(
        Object.entries(config.projects.metadata).map(([key, value]) => [expandPath(key, base), value]),
      ),
    },
    security: {
      ...config.security,
      filesystem: {
        ...config.security.filesystem,
        projectRoots: config.security.filesystem.projectRoots.map((p) => expandPath(p, base)),
        additionalReadablePaths: config.security.filesystem.additionalReadablePaths.map((p) =>
          expandPath(p, base),
        ),
        deniedPaths: config.security.filesystem.deniedPaths.map((p) => expandPath(p, base)),
      },
    },
  };
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const warnings: string[] = [];

  // Load .env first: it may define MCP_ORCHESTRATOR_CONFIG itself.
  warnings.push(...loadDotEnv(cwd, env));

  const sourcePath = findConfigFile(cwd, options.configPath ?? env['MCP_ORCHESTRATOR_CONFIG']);

  let raw: Record<string, unknown> = {};
  if (sourcePath) {
    let text: string;
    try {
      text = readFileSync(sourcePath, 'utf8');
    } catch (error) {
      throw orchestratorError('INVALID_CONFIG', `cannot read config file ${sourcePath}`, { cause: error });
    }
    let parsed: unknown;
    try {
      // `yaml` parses a plain-data subset by default: no custom tags, no code
      // execution, so an untrusted config file cannot do more than be wrong.
      parsed = parseYaml(text);
    } catch (error) {
      throw orchestratorError(
        'INVALID_CONFIG',
        `config file ${sourcePath} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (parsed === null || parsed === undefined) raw = {};
    else if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw orchestratorError('INVALID_CONFIG', `config file ${sourcePath} must contain a YAML mapping`);
    } else raw = parsed as Record<string, unknown>;
  } else {
    warnings.push('no config file found; using built-in defaults (loopback, no auth)');
  }

  warnings.push(...applyEnvOverrides(raw, env));
  warnings.push(...resolveMemoryEnv(raw, env, cwd));

  const result = appConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw orchestratorError('INVALID_CONFIG', `invalid configuration:\n${issues}`, {
      details: result.error.issues.map((issue) => ({
        path: issue.path.map((p) => String(p)),
        message: issue.message,
      })),
    });
  }

  const config = absolutisePaths(mergeBuiltInProfiles(result.data), cwd);

  // Memory is enabled by default and every provider other than `none` is HTTP,
  // so a config with no base URL gets a provider with nowhere to query: every
  // search returns nothing, and it looks exactly like "the user has no
  // memories". Say so out loud rather than failing to start, which would break
  // any deployment that simply never wanted memory.
  if (config.memory.enabled && config.memory.provider !== 'none' && !config.memory.baseUrl) {
    warnings.push(
      'memory is enabled but memory.baseUrl is not set, so every recall will return nothing; ' +
        'set memory.baseUrl or set memory.provider to "none"',
    );
  }
  // The refresh grace exists so that a client which retried after losing the
  // response is not mistaken for an attacker replaying a stolen token. If it is
  // shorter than the time a client waits before retrying, that protection is
  // inverted: an ordinary retry arrives outside the window, is classified as
  // theft, and revokes the entire rotation chain -- forcing the user through
  // re-consent for doing nothing wrong. The schema comment already says "two
  // times the client timeout is a reasonable rule"; nothing checked it, which
  // is the same gap as a documented setting with no caller.
  if (config.server.auth.refreshReplayGraceMs < config.server.requestTimeoutMs) {
    warnings.push(
      `server.auth.refreshReplayGraceMs (${config.server.auth.refreshReplayGraceMs}ms) is below ` +
        `server.requestTimeoutMs (${config.server.requestTimeoutMs}ms), so a client that retries after a ` +
        'lost response will be treated as a stolen-token replay and have its whole chain revoked; ' +
        'roughly twice the request timeout is the intended relationship',
    );
  }

  if (config.memory.provider === 'mem0-cli') {
    warnings.push('memory.provider "mem0-cli" is a deprecated alias for "mem0-http"; no CLI bridge exists');
  }
  return { config, sourcePath, warnings };
}
