import { z } from 'zod';

/**
 * Configuration schema.
 *
 * Everything the operator can tune lives here. Two rules shape this file:
 *  - provider behaviour (enabled, priority, timeout, cache, options) must be
 *    changeable WITHOUT editing source, so providers get an open `options` bag;
 *  - the server refuses to start in an unsafe public configuration, which is
 *    enforced by `superRefine` at the bottom rather than at call sites.
 */

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('/') || value.startsWith('~'), {
    message: 'must be an absolute path (or start with ~)',
  });

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

export const loggingConfigSchema = z.object({
  level: logLevelSchema.default('info'),
  pretty: z.boolean().default(false),
  filePath: z.string().optional(),
  /** Log the literal text of spoken instructions. Off by default on purpose. */
  logInstructionText: z.boolean().default(false),
});

export const authConfigSchema = z.object({
  /**
   * - `none`: no auth. Only permitted when bound to loopback.
   * - `bearer`: static bearer token(s) from the environment.
   * - `oauth`: RFC 9728 protected-resource metadata + external token verifier.
   */
  mode: z.enum(['none', 'bearer', 'oauth']).default('none'),
  /**
   * Names of environment variables holding accepted bearer tokens. The tokens
   * themselves are NEVER written to config — only the variable names are.
   */
  tokenEnvVars: z.array(z.string().min(1)).default(['MCP_ORCHESTRATOR_TOKEN']),
  /**
   * Public URL this server is reached at, e.g. https://mcp.example.com.
   * Required for `oauth`: it is the issuer, and the canonical resource
   * identifier that access tokens are bound to (RFC 8707 audience).
   */
  resourceUrl: z.string().url().optional(),
  /** External authorization server issuers, when not using the built-in one. */
  authorizationServers: z.array(z.string().url()).default([]),
  requiredScopes: z.array(z.string()).default([]),
  /** Scopes advertised in discovery metadata. */
  scopesSupported: z.array(z.string()).default(['mcp']),
  /**
   * Env var holding the password that gates the OAuth consent screen. This is
   * the single human secret in the flow: it is what proves the browser session
   * approving a client is really the operator.
   */
  adminPasswordEnvVar: z.string().default('MCP_ORCHESTRATOR_ADMIN_PASSWORD'),
  /** Short-lived by design; the refresh token carries longevity. */
  accessTokenTtlMs: z.number().int().min(60_000).default(3_600_000),
  refreshTokenTtlMs: z.number().int().min(300_000).default(2_592_000_000),
  /**
   * How long after a rotation a replay of the old refresh token counts as a
   * benign retry rather than theft.
   *
   * MUST be at least as long as the client's own refresh-request timeout,
   * and comfortably longer is better. A client whose HTTP timeout is 30s and
   * which retries a dropped refresh lands at T+30s; if the grace is shorter
   * than that, the retry is classified as theft, the chain is revoked, and
   * the user is pushed back through consent for nothing - the precise false
   * positive this window exists to prevent. The default assumes a phone on a
   * poor link. Two times the client timeout is a reasonable rule.
   *
   * The cost of a longer window is detection latency, and it is smaller than
   * it looks: the grace suppresses the victim's immediate duplicate either
   * way, so a lost rotation race is caught on the victim's NEXT scheduled
   * refresh - bounded by refresh cadence, not by this value.
   */
  refreshReplayGraceMs: z.number().int().min(0).default(60_000),
  authorizationCodeTtlMs: z.number().int().min(10_000).default(120_000),
});

export const serverConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  /** 0 asks the OS for an ephemeral port; useful for tests and side-by-side runs. */
  port: z.number().int().min(0).max(65535).default(8787),
  /** MCP endpoint path. */
  mcpPath: z.string().startsWith('/').default('/mcp'),
  /**
   * Hostnames accepted in the Host header (DNS-rebinding protection). Loopback
   * names are always allowed; add your tunnel hostname here when proxying.
   */
  allowedHosts: z.array(z.string().min(1)).default([]),
  /** Origins accepted for browser-originated requests. */
  allowedOrigins: z.array(z.string().min(1)).default([]),
  /**
   * Explicit acknowledgement required to bind a non-loopback address. Exists so
   * that exposing this server is always a deliberate act.
   */
  allowNonLoopbackBind: z.boolean().default(false),
  /** Max accepted JSON body size. Guards against trivial memory DoS. */
  maxBodyBytes: z.number().int().min(1024).default(1_048_576),
  requestTimeoutMs: z.number().int().min(1000).default(30_000),
  auth: authConfigSchema.prefault({}),
});

export const databaseConfigSchema = z.object({
  path: z.string().default('data/orchestrator.sqlite'),
  /** WAL keeps readers non-blocking while a worker writes progress events. */
  walMode: z.boolean().default(true),
  busyTimeoutMs: z.number().int().min(0).default(5000),
});

export const filesystemSecuritySchema = z.object({
  projectRoots: z.array(absolutePath).default([]),
  allowOutsideProjectRead: z.boolean().default(false),
  allowOutsideProjectWrite: z.boolean().default(false),
  /**
   * Paths the worker may always read even though they sit outside project roots
   * (Claude's own configuration, for instance). Never writable.
   */
  additionalReadablePaths: z.array(absolutePath).default([]),
  /** Paths that are never readable or writable regardless of other rules. */
  deniedPaths: z.array(absolutePath).default([]),
});

export const approvalPolicySchema = z.object({
  READ_ONLY: z.enum(['allow', 'ask', 'deny']).default('allow'),
  LOCAL_REVERSIBLE: z.enum(['allow', 'ask', 'deny']).default('allow'),
  EXTERNAL_SIDE_EFFECT: z.enum(['allow', 'ask', 'deny']).default('ask'),
  DESTRUCTIVE: z.enum(['allow', 'ask', 'deny']).default('ask'),
  PROHIBITED: z.enum(['allow', 'ask', 'deny']).default('deny'),
});

export const securityConfigSchema = z.object({
  filesystem: filesystemSecuritySchema.prefault({}),
  approvals: approvalPolicySchema.prefault({}),
  /**
   * How long a pending question or approval waits for an answer.
   *
   * On expiry the request is voided and the approval FAILS CLOSED: the tool is
   * denied and the worker carries on without it (see handleToolPermission in
   * services/claude/worker.ts). The session is deliberately NOT failed - an
   * earlier version of this comment said it was, which was wrong, and acting
   * on that claim would kill work that correctly continued after a denial.
   *
   * What actually stops a worker pinning a project lock forever is the
   * wall-clock cap, claude.sessionTimeoutMs, enforced by the session reaper.
   */
  pendingRequestTimeoutMs: z.number().int().min(10_000).default(1_800_000),
});

export const claudeWorkerConfigSchema = z.object({
  /** Explicit path to the Claude Code executable. Auto-detected when absent. */
  executablePath: z.string().optional(),
  model: z.string().optional(),
  /**
   * Which on-disk Claude settings layers the worker loads. Must include
   * 'project' for CLAUDE.md files to be read, which is how the user's existing
   * preferences reach the worker.
   */
  settingSources: z.array(z.enum(['user', 'project', 'local'])).default(['user', 'project', 'local']),
  maxTurns: z.number().int().min(1).default(300),
  /** Wall-clock cap for a single work session. */
  sessionTimeoutMs: z.number().int().min(60_000).default(7_200_000),
  /** How long start_work_session waits for the worker to acknowledge. */
  startAckTimeoutMs: z.number().int().min(500).default(5000),
  /** Keep at most this many progress events per session in the database. */
  maxProgressEvents: z.number().int().min(10).default(500),
  /** One write-capable session per project. Read-only sessions stay concurrent. */
  enforceProjectWriteLock: z.boolean().default(true),
});

export const providerConfigSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().optional(),
  timeoutMs: z.number().int().min(50).optional(),
  cacheTtlMs: z.number().int().min(0).optional(),
  /**
   * Free-form provider-specific settings, handed to the provider verbatim as
   * `InitialContextRequest.options`. Adding a provider therefore never requires
   * touching this schema.
   */
  options: z.record(z.string(), z.unknown()).prefault({}),
});

export const initialContextConfigSchema = z.object({
  maxTokens: z.number().int().min(200).default(2500),
  /** Default per-provider timeout; a provider entry can override it. */
  defaultTimeoutMs: z.number().int().min(50).default(1500),
  /** Bounded concurrency for provider fan-out. */
  maxConcurrency: z.number().int().min(1).default(8),
  defaultProfile: z.string().default('default'),
  providers: z.record(z.string(), providerConfigSchema).prefault({}),
});

export const contextProfileSchema = z.object({
  description: z.string().optional(),
  providers: z.array(z.string()),
  maxTokens: z.number().int().min(200).optional(),
});

export const tailscaleConfigSchema = z.object({
  enabled: z.boolean().default(true),
  executablePath: z.string().default('tailscale'),
  cacheTtlMs: z.number().int().min(0).default(10_000),
  timeoutMs: z.number().int().min(100).default(3000),
});

export const projectsConfigSchema = z.object({
  roots: z.array(absolutePath).default([]),
  /** Directory names never descended into. */
  ignoreDirs: z
    .array(z.string())
    .default(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', 'target', 'vendor']),
  /** How deep below each root to look for project markers. */
  maxDepth: z.number().int().min(1).max(6).default(2),
  /** Full rescan interval. Between rescans the index is served from SQLite. */
  refreshIntervalMs: z.number().int().min(5000).default(300_000),
  metadata: z
    .record(
      z.string(),
      z.object({
        displayName: z.string().optional(),
        aliases: z.array(z.string()).default([]),
        description: z.string().optional(),
        ignore: z.boolean().default(false),
      }),
    )
    .prefault({}),
});

export const memoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** `mem0-cli` shells out to the existing bridge; `none` disables retrieval. */
  provider: z.enum(['mem0-cli', 'mem0-http', 'none']).default('mem0-cli'),
  /** For `mem0-cli`: interpreter and script path of the existing Mem0 bridge. */
  pythonPath: z.string().optional(),
  scriptPath: z.string().optional(),
  /**
   * For `mem0-http`: base URL of the Mem0 service.
   *
   * Usually left unset in YAML and supplied at runtime from `envFile` /
   * `MEM0_BASE_URL`, so a private endpoint never lands in a tracked file.
   */
  baseUrl: z.string().url().optional(),
  /**
   * Optional `KEY=VALUE` file sourced at startup for MEM0_* settings. Values
   * are read into memory only; they are never logged or echoed by doctor.
   */
  envFile: z.string().optional(),
  /** Env var names holding Mem0 credentials. Only NAMES live in config. */
  apiKeyEnvVar: z.string().default('MEM0_API_KEY'),
  userIdEnvVar: z.string().default('MEM0_USER_ID'),
  timeoutMs: z.number().int().min(100).default(4000),
  maxResults: z.number().int().min(1).max(50).default(8),
  /** Upper bound on tokens of memory text injected into initial context. */
  maxTokens: z.number().int().min(100).default(1200),
  /** Writes are opt-in; the orchestrator must not silently record everything. */
  allowWrites: z.boolean().default(false),
});

export const computerMetadataSchema = z.object({
  displayName: z.string().optional(),
  role: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
  capabilities: z
    .object({
      cpu: z.string().optional(),
      ramGb: z.number().optional(),
      gpu: z.string().optional(),
      vramGb: z.number().optional(),
      services: z.array(z.string()).default([]),
    })
    .optional(),
});

export const appConfigSchema = z
  .object({
    server: serverConfigSchema.prefault({}),
    logging: loggingConfigSchema.prefault({}),
    database: databaseConfigSchema.prefault({}),
    security: securityConfigSchema.prefault({}),
    claude: claudeWorkerConfigSchema.prefault({}),
    tailscale: tailscaleConfigSchema.prefault({}),
    projects: projectsConfigSchema.prefault({}),
    memory: memoryConfigSchema.prefault({}),
    initialContext: initialContextConfigSchema.prefault({}),
    contextProfiles: z.record(z.string(), contextProfileSchema).prefault({}),
    computers: z.record(z.string(), computerMetadataSchema).prefault({}),
  })
  .superRefine((config, ctx) => {
    const loopback = isLoopbackHost(config.server.host);

    // The single most important invariant in the file: a powerful,
    // machine-controlling MCP server must never listen off-host unauthenticated.
    if (!loopback && config.server.auth.mode === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['server', 'auth', 'mode'],
        message:
          `refusing unsafe configuration: host "${config.server.host}" is not loopback but auth.mode is "none". ` +
          'Set server.auth.mode to "bearer" or "oauth", or bind 127.0.0.1 and put a TLS proxy in front.',
      });
    }

    if (!loopback && !config.server.allowNonLoopbackBind) {
      ctx.addIssue({
        code: 'custom',
        path: ['server', 'allowNonLoopbackBind'],
        message:
          `host "${config.server.host}" is not loopback. Set server.allowNonLoopbackBind=true to confirm this is intended.`,
      });
    }

    if (config.server.auth.mode === 'bearer' && config.server.auth.tokenEnvVars.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['server', 'auth', 'tokenEnvVars'],
        message: 'auth.mode "bearer" requires at least one entry in auth.tokenEnvVars',
      });
    }

    if (config.server.auth.mode === 'oauth') {
      if (!config.server.auth.resourceUrl) {
        ctx.addIssue({
          code: 'custom',
          path: ['server', 'auth', 'resourceUrl'],
          message: 'auth.mode "oauth" requires auth.resourceUrl (the public https URL of this server)',
        });
      } else if (!config.server.auth.resourceUrl.startsWith('https://')) {
        // OAuth 2.1 requires the authorization server be served over HTTPS.
        ctx.addIssue({
          code: 'custom',
          path: ['server', 'auth', 'resourceUrl'],
          message: 'auth.resourceUrl must be https (OAuth 2.1 requires TLS); terminate TLS at your proxy',
        });
      }
      if (config.server.auth.refreshTokenTtlMs <= config.server.auth.accessTokenTtlMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['server', 'auth', 'refreshTokenTtlMs'],
          message: 'refreshTokenTtlMs must be longer than accessTokenTtlMs',
        });
      }
    }

    // A profile naming a provider that does not exist is a silent no-op at
    // runtime, so fail loudly at load time instead.
    for (const [profileName, profile] of Object.entries(config.contextProfiles)) {
      if (profile.providers.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['contextProfiles', profileName, 'providers'],
          message: `context profile "${profileName}" lists no providers`,
        });
      }
    }

    if (config.memory.enabled && config.memory.provider === 'mem0-http' && !config.memory.baseUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['memory', 'baseUrl'],
        message: 'memory.provider "mem0-http" requires memory.baseUrl',
      });
    }
  });

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type SecurityConfig = z.infer<typeof securityConfigSchema>;
export type ClaudeWorkerConfig = z.infer<typeof claudeWorkerConfigSchema>;
export type ProjectsConfig = z.infer<typeof projectsConfigSchema>;
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
export type TailscaleConfig = z.infer<typeof tailscaleConfigSchema>;
export type InitialContextConfig = z.infer<typeof initialContextConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ContextProfile = z.infer<typeof contextProfileSchema>;
export type ComputerMetadataConfig = z.infer<typeof computerMetadataSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

/**
 * Whether a bind address is loopback-only. `0.0.0.0` and `::` are explicitly
 * NOT loopback: they are the classic way to accidentally publish a service.
 */
export function isLoopbackHost(host: string): boolean {
  const normalised = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(normalised)) return true;
  return normalised.startsWith('127.');
}
