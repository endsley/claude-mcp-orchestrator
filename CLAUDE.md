# Claude MCP Orchestrator

## Purpose

This is the secure orchestration boundary between a remote Claude conversation
(including Android voice) and a local Claude Code worker. The remote client
uses high-level intent tools; it never receives arbitrary shell, filesystem,
or sudo tools.

## Architecture and invariants

- `src/server`, `src/tools`, `src/services/sessions`, and `src/services/claude`
  own MCP transport, authentication, persistence, work-session state, and the
  Claude Agent worker.
- `src/context` is plug-in context assembly. Add a provider, register it in
  `default-providers.ts`, and configure it; do not add a provider switch to the
  assembler.
- `src/services/tailscale`, `projects`, `memory`, and `system` normalize
  external state behind testable adapters.
- Never expose an arbitrary-shell, arbitrary-file, Python-eval, or sudo MCP
  tool. New actions must remain high-level and route through the worker.
- Preserve Claude Code's existing `user`, `project`, and `local` setting
  sources. Do not use bypass-permissions or `--restricted`.
- External side effects and destructive actions require the policy/approval
  path. Do not weaken authentication, filesystem scope, or redaction for a
  test.
- A Claude Agent SDK `result` message ends a TURN, not the session. A finished
  turn must leave the work session `idle` (worker alive, conversation
  resumable, project lock held) - never `completed`. Marking it terminal breaks
  every follow-up instruction, which is the product's core feature.
- Auth modes are handled exhaustively and the fallback is DENY. An
  unimplemented mode must refuse to start, never fall through to no auth.
- Key-based redaction matches whole WORDS. Substring matching silently
  destroyed `estimatedTokens`/`maxTokens`; value-pattern scrubbing is the real
  defence and must stay.
- Do not log secrets, bearer tokens, authorization headers, raw environment
  values, or full user instructions at normal log levels.

## Commands

```bash
npm run dev
npm run typecheck
npm run lint
npm test
npm run doctor
npm run build && npm start
```

Run all relevant unit and integration tests after a change. A meaningful
security or session-state change requires a focused regression test.

## Context-provider extension pattern

Implement `InitialContextProvider`, return concise `lines`, register it in
`registerDefaultProviders`, then enable it in `config/orchestrator.yaml` and a
named profile. Provider failures must be isolated; respect `request.signal`.
The assembler, public MCP protocol, and every existing provider should need no
change.
