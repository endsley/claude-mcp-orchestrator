# Claude MCP Orchestrator

An MCP orchestration service that lets Claude on Android—particularly the live
voice interface—use Claude Code or Codex on a Linux workstation without being handed
primitive machine-control tools. It is an **intent, context, session, and
policy layer**, not a remote shell.

```text
Android Claude / live voice
          │ high-level MCP tools over authenticated HTTPS
          ▼
Claude MCP Orchestrator
  ├─ context-provider registry ── Tailscale / projects / Mem0 / system state
  ├─ SQLite ── durable work sessions, progress, pending questions/results
  ├─ policy ── scope, approvals, redaction, authentication
  └─ Claude Agent / Codex worker ── existing local agent configuration and tools
          ▼
files · Git · tests · browser · existing Claude MCP integrations
```

## Trust boundary

The phone-side model gets tools such as `start_work_session` and
`get_environment_context`, not `run_shell`, arbitrary file read/write, Python
evaluation, sudo, or deployment primitives. The selected agent runs locally. Claude Code uses its normal `user`, `project`, and `local`
configuration sources; Codex uses its installed CLI configuration and durable thread resume.

The application binds to `127.0.0.1` by default. It refuses a non-loopback
bind without authentication and an explicit configuration acknowledgement.

**`auth.mode: oauth` is not implemented in this build and the server refuses to
start with it**, rather than silently serving unauthenticated traffic. The
supported modes are:

- `none` — permitted only on a loopback bind (local development).
- `bearer` — constant-time-compared static token(s), read from environment
  variables named in config. Tokens under 24 characters are rejected.

For public remote use, terminate TLS in a reverse proxy or tunnel you
administer and either (a) require the bearer token over HTTPS, or (b) put an
authenticating proxy (for example oauth2-proxy, Cloudflare Access, or an
equivalent identity-aware proxy) in front and keep the orchestrator on
loopback. Do not expose the local port directly.

> Claude custom connectors run from Anthropic's cloud, so a Tailnet-only URL is
> not reachable by Android Claude. You need public HTTPS with a recognized CA
> certificate. Tailscale remains the source of machine awareness and the basis
> for future remote workers.

## MCP capabilities

The server exposes concise, voice-friendly high-level tools:

- `get_environment_context`, `list_context_capabilities`
- `list_computers`, `get_computer`
- `list_projects`, `find_project`, `get_project_context`
- `recall_context`
- `start_work_session`, `continue_work_session`,
  `send_work_session_instruction`, `get_work_session_status`,
  `get_work_session_result`, `respond_to_work_session`, `cancel_work_session`
- `get_recent_activity`

Errors are structured (`PROJECT_AMBIGUOUS`, `COMPUTER_OFFLINE`,
`APPROVAL_REQUIRED`, `MEMORY_UNAVAILABLE`, and so on), rather than generic
server errors. Tool responses avoid raw transcripts and chain-of-thought.

## Outside agent access (coordination board)

Agents that are not the owner (another assistant, a coding agent, a CI job) can
use the shared code coordination board through this server, and nothing else.
They get seven tools: `code_coordination_board` (read active tasks, claims and
recent messages), `post_code_task`, `claim_code_files`, `release_code_files`,
`heartbeat_code_task`, `message_code_agents` and `finish_code_task`. They cannot
list or call `start_work_session` or any other tool. The server checks scope
on every call and also leaves non-permitted tools out of `tools/list`.

Your board identity comes from your credential, and tool arguments cannot
change it:

| Credential | Name on the board | Board session id |
| --- | --- | --- |
| Board token key | the key's name, e.g. `helper-bot` | `ext-key-<name>` |
| OAuth token | `oauth:<client_name>` | `ext-oauth-<client_id>` |

Projects are named by alias (for example `demo-app`). Claims are paths
relative to the project root, of kind `file`, `tree` or `project`. Writes are
rate-limited per identity: 30 a minute by default.

### Option 1: OAuth (an MCP client with a browser)

1. Add `https://<server>/mcp` as a remote MCP server in your client. The client
   finds the OAuth endpoints itself and registers dynamically.
2. Request the `board` scope (`scope=board`). If your client cannot choose a
   scope, the owner can still narrow the grant on the consent page.
3. The owner approves on the consent page, which shows the scope being
   granted. A `board` request can only be granted `board`. A full-access
   (`mcp`) request can be narrowed to "Coordination board only" before
   approving.

Access tokens last an hour; refresh tokens last 30 days and rotate on use.

### Option 2: a board token key (headless agents)

The owner creates a key on the server host:

```bash
npm run -s board-key -- create <agent-name>               # prints the key once, on stdout
npm run -s board-key -- create <agent-name> --write-file  # or writes ~/.config/claude-mcp-orchestrator/board-keys/<agent-name>.key (mode 600)
npm run -s board-key -- list
npm run -s board-key -- revoke <agent-name>
```

Send the key as a bearer token on every MCP request:

```
Authorization: Bearer mcpbk_...
```

A key grants the board scope only. It does not expire, and revoking it takes
effect on the next request. Only the key's SHA-256 is stored, so a lost key
cannot be recovered: revoke it and create a new one. Keep it out of Git.

### Server side

`board:` in `config/orchestrator.yaml` sets the board service nodes (in
failover order), the file that holds the board service token (read on every
call, never logged, and sent only to the listed nodes), and the project
aliases outside agents may use. See `config/orchestrator.example.yaml`.
`scopesSupported` must include `board` for OAuth board grants.

## Context providers and profiles

`src/context` is an extensible registry. Providers run concurrently with
bounded concurrency, per-provider timeouts, failure isolation, health state,
and a global token budget. Higher-priority active-session context survives
before lower-priority diagnostics.

Initial providers are:

| Provider | Purpose |
| --- | --- |
| `computers` | Live Tailscale inventory merged with editable aliases/roles |
| `projects` | Bounded discovery under configured roots, Git summary, aliases |
| `workSessions` | Compact active-session status only |
| `preferences` | Safe pointer to the existing authoritative Claude settings |
| `memory` | Focus-relevant, deduplicated Mem0 results only |
| `systemStatus` | Cached load, RAM, disk, and inexpensive GPU summary |

Profiles in `config/orchestrator.yaml` are `default`, `coding`,
`infrastructure`, and `minimal`. `get_environment_context(profile="coding",
focus="home dashboard mobile navigation")` can add task-relevant Mem0 without dumping
the memory database.

### Add a provider

1. Implement `InitialContextProvider` in `src/context/providers/`.
2. Register it in `src/context/default-providers.ts`.
3. Add a provider setting and profile membership in `config/orchestrator.yaml`.
4. Add isolated timeout/failure/budget tests.

No assembler rewrite or public MCP protocol change is required. The shipped
`SystemStatusContextProvider` is the reference extension.

## Tailscale computers

The initial inventory is generated from your local `tailscale status --json`,
so it reflects your own machines. For example:

| Machine | Status observed during setup |
| --- | --- |
| `workstation` | local primary Linux workstation |
| `build-host` | online; direct route observed |
| `media-host` | online |
| `app-host` | online |
| `laptop` | offline |
| `backup-host` | offline |

Edit the `computers` block in `config/orchestrator.yaml`
to set display names, roles, aliases, and capability notes. The resolver checks
stable ID, machine name, display name, aliases, and role case-insensitively;
ambiguous phrases return candidates instead of choosing a computer silently.
`online`, `reachable`, direct, relay, idle, and last-seen are distinct states.

V1 is intentionally local-worker only. The computer resolver/service boundary
is the extension point for a later authenticated worker on a selected Tailscale
machine.

## Project discovery

Only configured roots are scanned—for example `~/code` and
`~/ambient`—and discovery is bounded/cached. A candidate needs a
marker such as `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`,
`CLAUDE.md`, or `README.md`. Metadata aliases are declarative; they never
invent a missing path.

Aliases are yours to declare—`home dashboard`, `the transit app`, `the clinic
site`, and so on. Edit them in `config/orchestrator.yaml`.

## Mem0

The service reuses the existing central Mem0 REST deployment. Its endpoint,
user identity, and API key are environment-only values (normally inherited from
the existing `mem0.env` by the user service); they are never committed or
printed. Retrieval is timeout-bounded, failover-aware, deduplicated, and only
used when the request has a relevant focus. Writes default to disabled and
require an explicit durable-memory policy.

Mem0/Tailscale failure degrades only that provider. Project, system, and work
session tools continue to work.

## Claude work sessions

Application sessions are persisted in SQLite and have explicit states:

```
starting → working → idle → working → ... → completed / failed / cancelled
              ↓  ↑
   needs_input / awaiting_approval          (restart) → interrupted → working
```

`idle` is the important one. The Claude Agent SDK emits a result message at the
end of every **turn**, not at the end of the conversation, so a finished turn
leaves the session `idle`: the worker is still alive, the Claude conversation is
still resumable, and the project write lock is still held. A follow-up such as
"make it smaller" moves it back to `working` in the *same* conversation.
Treating a turn result as session completion is what makes follow-ups fail, and
there is a regression test for exactly that.

Invalid transitions are rejected rather than tolerated. One write-capable
session per project is enforced; read-only sessions may run in parallel.

The Claude Agent worker is started asynchronously. The MCP acknowledgement
returns immediately; progress is reduced to safe structured events. Follow-up
instructions are queued into the same active worker. On restart, the service
retains its application session and Claude session ID, attempts supported
resume, and reports a recovery note when continuity was reconstructed rather
than perfect. `cancel_work_session` uses the Agent SDK interruption mechanism
before process termination is considered.

The real-worker smoke test (`scripts/smoke-worker.ts`) creates a dedicated
temporary Git fixture, never a production project: Claude reads a file, makes
a controlled trivial edit, and runs `npm test`.

## Configuration and local operation

```bash
cp .env.example .env                 # keep it 0600; do not commit it
npm install
npm run typecheck
npm test
npm run doctor
npm run dev
```

`config/orchestrator.yaml` controls host/port, security scope, project roots,
provider enablement/priority/timeout/cache/options, profiles, Tailscale, Mem0,
and worker settings. Environment variables hold secrets and deployment-specific
addresses. `npm run doctor` checks configuration, SQLite, Claude Code/Agent
SDK, Tailscale, Mem0, project roots, providers, authentication, and readiness
without echoing secret values.

Useful commands:

```bash
npm run build
npm start
npm run lint
npm test
npm run test:integration
npm run doctor
npx tsx scripts/smoke-worker.ts
```

### Measured local responsiveness

On the initial Linux workstation, `npm run bench` measured the actual local
MCP tool path at warm p95: environment context **23.5 ms**, context
capabilities **18.7 ms**, computers **13.1 ms**, project resolution **13.1
ms**, and recent activity **16.7 ms**. The first environment-context request
was **602.8 ms** because it initializes live providers; subsequent voice turns
reuse short, bounded status caches. Tailscale inventory, project indexing, and
system status are cached, while memory *search results* are never globally
cached. Numbers are operational evidence, not guarantees; rerun the benchmark
after changing provider configuration or hardware.

## Linux user service

An example is at `systemd/claude-mcp-orchestrator.service`. Review its paths,
then install it only under the ordinary user account:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/claude-mcp-orchestrator.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-mcp-orchestrator
systemctl --user status claude-mcp-orchestrator
```

The unit sets `HOME` and a PATH containing `~/.local/bin` so Claude Code and Codex can
load their existing authentication and configuration. It is not installed
automatically and does not alter a firewall, proxy, tunnel, or Tailscale ACL.

## Android Claude connector setup

1. Finish local tests and `npm run doctor`.
2. Keep the service on loopback and provide public TLS through a proxy/tunnel
   you administer. Do not publish the local port directly.
3. Authenticate the public endpoint. Either require the bearer token from
   `MCP_ORCHESTRATOR_TOKEN` over HTTPS, or front the server with an
   identity-aware proxy. A recognized CA certificate is required for remote
   connectors. Native OAuth in the orchestrator itself is future work and is
   currently refused at startup.
4. Add the public Streamable HTTP MCP URL in Claude's custom-connector UI
   (mobile follows the same configured connector), authenticate, and enable it
   for the conversation.
5. Ask `get_environment_context` before issuing an ambiguous machine or
   project request. Android Claude should continue an active work session for
   clear follow-ups such as “make it smaller.”

## Testing and limitations

Tests cover provider registration/configuration, profile inclusion, token
trimming, bounded parallelism, timeout/failure isolation, real-shaped
Tailscale normalization, aliases/ambiguity, project discovery, and Mem0
deduplication. Integration tests mock Tailscale, Mem0, and the Agent SDK;
local smoke tests validate the actual Tailscale inventory and worker fixture.

V1 deliberately does not implement remote worker execution, automatic proxy
installation, firewall changes, a homegrown OAuth authorization server, or
automatic Mem0 writes. Good next extensions are authenticated remote workers,
calendar/email/GitHub providers, artifact serving, and OIDC deployment recipes
for the chosen identity provider.
