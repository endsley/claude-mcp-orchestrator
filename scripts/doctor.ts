#!/usr/bin/env tsx
/**
 * Preflight diagnostics.
 *
 * Every check answers one question: would the server work right now, and if
 * not, what does the operator have to change? Output never contains secrets —
 * only whether a secret is present, never its value.
 *
 * That last sentence used to be an assertion with nothing behind it. `detail`
 * is free text assembled from exception messages and subprocess output, so it
 * is exactly as trustworthy as whatever threw. Every line now leaves through
 * redactText, which is worth more here than in the server: doctor output is
 * what a human pastes into an issue or a chat window.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { buildApplication } from '../src/app.js';
import { createNullLogger } from '../src/logging/logger.js';
import { OrchestratorError } from '../src/types/errors.js';
import { redactText } from '../src/security/redaction.js';

const run = promisify(execFile);

type Level = 'OK' | 'WARNING' | 'ERROR';

interface Check {
  name: string;
  level: Level;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, level: Level, detail: string): void {
  checks.push({ name, level, detail });
}

async function main(): Promise<void> {
  const logger = createNullLogger();

  let app: Awaited<ReturnType<typeof buildApplication>> | undefined;
  try {
    app = await buildApplication({ logger });
    record('configuration', 'OK', `loaded from ${app.loaded.sourcePath ?? 'built-in defaults'}`);
    for (const warning of app.loaded.warnings) record('configuration', 'WARNING', warning);
  } catch (error) {
    const message = OrchestratorError.is(error) ? `[${error.code}] ${error.message}` : String(error);
    record('configuration', 'ERROR', message);
    report();
    // exitCode, not exit(): exit() can terminate before a piped stdout is
    // flushed, which made doctor silent over SSH and in CI.
    process.exitCode = 2;
    return;
  }

  const { services } = app;
  const config = services.config;

  // ---- database
  try {
    const row = services.db.prepare('SELECT COUNT(*) AS n FROM work_sessions').get() as { n: number };
    record('database', 'OK', `${config.database.path} reachable, ${row.n} work sessions recorded`);
  } catch (error) {
    record('database', 'ERROR', `cannot query database: ${String(error)}`);
  }

  // ---- auth / exposure
  const loopback = config.server.host.startsWith('127.') || config.server.host === 'localhost' || config.server.host === '::1';
  if (loopback && config.server.auth.mode === 'none') {
    record('authentication', 'OK', 'loopback bind with no auth (safe for local use)');
  } else if (!loopback && config.server.auth.mode === 'none') {
    record('authentication', 'ERROR', 'non-loopback bind without authentication; the server will refuse to start');
  } else if (config.server.auth.mode === 'bearer') {
    const present = config.server.auth.tokenEnvVars.filter((name) => (process.env[name] ?? '').length >= 24);
    if (present.length > 0) record('authentication', 'OK', `${present.length} bearer token(s) present in the environment`);
    else record('authentication', 'ERROR', `bearer mode but no usable token in ${config.server.auth.tokenEnvVars.join(', ')}`);
  } else {
    record('authentication', 'OK', `auth mode "${config.server.auth.mode}"`);
  }

  // ---- Claude Code / Agent SDK
  const claudePath = config.claude.executablePath;
  try {
    const { stdout } = await run(claudePath ?? 'claude', ['--version'], { timeout: 10_000 });
    record('claude code', 'OK', stdout.trim());
  } catch {
    record(
      'claude code',
      'ERROR',
      `could not run "${claudePath ?? 'claude'} --version"; set claude.executablePath in config`,
    );
  }

  // ---- Tailscale
  if (!config.tailscale.enabled) {
    record('tailscale', 'WARNING', 'disabled in configuration; machine awareness is off');
  } else {
    try {
      const computers = await services.computers.list(true);
      const online = computers.filter((c) => c.tailscale.online === true).length;
      const withMetadata = computers.filter((c) => c.hasHumanMetadata).length;
      record('tailscale', 'OK', `${computers.length} machines known, ${online} online`);
      if (withMetadata < computers.length) {
        record(
          'computer metadata',
          'WARNING',
          `${computers.length - withMetadata} machine(s) have no role/alias configured; add them under "computers:" in the config`,
        );
      }
    } catch (error) {
      record('tailscale', 'WARNING', `unavailable (${String(error)}); other subsystems continue to work`);
    }
  }

  // ---- projects
  const roots = config.projects.roots.length > 0 ? config.projects.roots : config.security.filesystem.projectRoots;
  if (roots.length === 0) {
    record('project roots', 'WARNING', 'no project roots configured; project tools will return nothing');
  } else {
    const missing = roots.filter((root) => !existsSync(root));
    if (missing.length > 0) record('project roots', 'WARNING', `configured but missing: ${missing.join(', ')}`);
    try {
      const projects = await services.projects.list(true);
      record('projects', 'OK', `${projects.length} projects indexed under ${roots.length} root(s)`);
    } catch (error) {
      record('projects', 'ERROR', `project scan failed: ${String(error)}`);
    }
  }

  // ---- memory
  if (!config.memory.enabled || config.memory.provider === 'none') {
    record('memory', 'WARNING', 'long-term memory disabled; recall_context will report unavailable');
  } else {
    try {
      const health = await services.memory.health();
      record(
        'memory',
        health.status === 'ok' ? 'OK' : health.status === 'disabled' ? 'WARNING' : 'WARNING',
        `${config.memory.provider}: ${health.status}${health.detail ? ` (${health.detail})` : ''}`,
      );
    } catch (error) {
      record('memory', 'WARNING', `health check failed: ${String(error)}`);
    }
  }

  // ---- context providers
  try {
    const capabilities = await services.contextAssembler.capabilities();
    const available = capabilities.filter((capability) => capability.available);
    record('context providers', available.length > 0 ? 'OK' : 'ERROR',
      `${available.length}/${capabilities.length} available: ${available.map((c) => c.id).join(', ') || 'none'}`);
    for (const capability of capabilities.filter((c) => !c.available)) {
      record('context provider', 'WARNING', `${capability.id} is unavailable`);
    }
  } catch (error) {
    record('context providers', 'ERROR', `assembler failed: ${String(error)}`);
  }

  // ---- filesystem scope
  const scopeRoots = config.security.filesystem.projectRoots.length > 0
    ? config.security.filesystem.projectRoots
    : roots;
  if (scopeRoots.length === 0) {
    record('filesystem scope', 'WARNING', 'no project roots; the worker has no permitted write area');
  } else {
    record('filesystem scope', 'OK', `${scopeRoots.length} root(s); outside-write ${config.security.filesystem.allowOutsideProjectWrite ? 'ALLOWED' : 'blocked'}`);
  }

  await app.shutdown();
  report();
  process.exitCode = checks.some((c) => c.level === 'ERROR') ? 1 : 0;
}

function report(): void {
  const pad = Math.max(...checks.map((c) => c.name.length), 10);
  for (const check of checks) {
    console.log(`${check.level.padEnd(7)} ${check.name.padEnd(pad)}  ${redactText(check.detail)}`);
  }
  const errors = checks.filter((c) => c.level === 'ERROR').length;
  const warnings = checks.filter((c) => c.level === 'WARNING').length;
  console.log(`\n${checks.length} checks: ${errors} error(s), ${warnings} warning(s).`);
}

main().catch((error: unknown) => {
  console.error('doctor failed:', redactText(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 2;
});
