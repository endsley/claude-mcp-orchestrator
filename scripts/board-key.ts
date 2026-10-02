#!/usr/bin/env tsx
/**
 * Manage board token keys for headless outside agents.
 *
 *   npm run board-key -- create <agent-name> [--write-file]
 *   npm run board-key -- list
 *   npm run board-key -- revoke <agent-name>
 *
 * `create` prints the new key ONCE, alone on stdout, so it can be captured
 * (`KEY=$(npm run -s board-key -- create helper-bot)`). Everything else goes to
 * stderr. With --write-file the key is written instead to
 * ~/.config/claude-mcp-orchestrator/board-keys/<agent-name>.key (mode 600,
 * directory mode 700) and only the path is printed.
 *
 * The key is a bearer credential for the board scope only. It is stored
 * hashed; a lost key cannot be recovered, only revoked and recreated.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { openDatabase } from '../src/db/database.js';
import { createNullLogger } from '../src/logging/logger.js';
import { assertValidKeyName, BoardKeyStore } from '../src/security/board-keys.js';
import { OrchestratorError } from '../src/types/errors.js';

export const KEY_DIR = join(homedir(), '.config', 'claude-mcp-orchestrator', 'board-keys');

function usage(): never {
  process.stderr.write(
    'usage:\n' +
      '  npm run board-key -- create <agent-name> [--write-file]\n' +
      '  npm run board-key -- list\n' +
      '  npm run board-key -- revoke <agent-name>\n',
  );
  process.exit(64);
}

function main(argv: string[]): void {
  const [command, name, ...rest] = argv;
  if (!command) usage();

  const loaded = loadConfig({ env: process.env });
  const db = openDatabase(loaded.config.database, createNullLogger());
  const store = new BoardKeyStore(db);

  try {
    if (command === 'create') {
      if (!name) usage();
      const writeFile = rest.includes('--write-file');
      assertValidKeyName(name);
      const target = join(KEY_DIR, `${name}.key`);
      if (writeFile && existsSync(target)) {
        throw new Error(`${target} already exists; remove it (or revoke and delete it) first`);
      }
      const { key } = store.create(name);
      if (writeFile) {
        mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
        chmodSync(KEY_DIR, 0o700);
        writeFileSync(target, `${key}\n`, { mode: 0o600, flag: 'wx' });
        process.stderr.write(`Created board key "${name}" (board scope only).\n`);
        process.stdout.write(`${target}\n`);
      } else {
        process.stderr.write(
          `Created board key "${name}" (board scope only). It is shown once; store it now.\n` +
            'The agent sends it as: Authorization: Bearer <key>\n',
        );
        process.stdout.write(`${key}\n`);
      }
      return;
    }

    if (command === 'list') {
      const rows = store.list();
      if (rows.length === 0) {
        process.stdout.write('No board keys.\n');
        return;
      }
      for (const row of rows) {
        process.stdout.write(
          [
            row.name.padEnd(24),
            row.revoked ? `revoked ${row.revokedAt ?? ''}`.padEnd(34) : 'active'.padEnd(34),
            `created ${row.createdAt}`,
            `last used ${row.lastUsedAt ?? 'never'}`,
          ].join('  ') + '\n',
        );
      }
      return;
    }

    if (command === 'revoke') {
      if (!name) usage();
      if (store.revoke(name)) {
        process.stdout.write(`Revoked board key "${name}".\n`);
        const file = join(KEY_DIR, `${name}.key`);
        if (existsSync(file)) process.stderr.write(`The key file ${file} is now useless; delete it.\n`);
      } else {
        process.stderr.write(`No active board key named "${name}".\n`);
        process.exitCode = 1;
      }
      return;
    }

    usage();
  } finally {
    db.close();
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${OrchestratorError.is(error) ? error.message : error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
