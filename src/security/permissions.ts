import type { PermissionClass, PermissionClassification } from '../types/permissions.js';
import { redactText } from './redaction.js';
import type { FilesystemScope } from './paths.js';

/**
 * Maps a proposed tool call onto a permission class.
 *
 * The threat model is not a malicious user — it is an LLM acting on ambiguous
 * instructions, possibly influenced by text it read in a repository or on the
 * web. So classification is deliberately pessimistic: anything unrecognised is
 * treated as more dangerous than the baseline, never less.
 */

const CLASS_SEVERITY: Record<PermissionClass, number> = {
  READ_ONLY: 0,
  LOCAL_REVERSIBLE: 1,
  EXTERNAL_SIDE_EFFECT: 2,
  DESTRUCTIVE: 3,
  PROHIBITED: 4,
};

export function maxClass(a: PermissionClass, b: PermissionClass): PermissionClass {
  return CLASS_SEVERITY[a] >= CLASS_SEVERITY[b] ? a : b;
}

/** Tools that only ever read. */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'TodoWrite',
  'WebSearch',
  'WebFetch',
  'Task',
  'Agent',
  'BashOutput',
  'ListMcpResources',
  'ReadMcpResource',
]);

/** Tools that modify files in place. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ApplyPatch']);

/**
 * Shell control operators that start a NEW command. Splitting on these is what
 * stops `ls && rm -rf ~` from being classified by its harmless prefix.
 */
const COMMAND_SEPARATORS = /(?:\|\||&&|;|\||\n|&(?!>))/g;

/** Command-substitution forms whose contents also have to be classified. */
const SUBSTITUTION = /\$\(([^)]*)\)|`([^`]*)`|<\(([^)]*)\)/g;

interface Rule {
  re: RegExp;
  class: PermissionClass;
  reason: string;
}

/**
 * Ordered most-dangerous-first; the first match on a segment wins, and the
 * worst match across all segments wins overall.
 */
const BASH_RULES: Rule[] = [
  // ---- prohibited by default: security controls and secret exposure
  { re: /\bsudo\b|\bdoas\b|\bpkexec\b/, class: 'PROHIBITED', reason: 'privilege escalation' },
  { re: /authorized_keys|\bssh-add\b|(^|\s)~?\/?\.ssh\//, class: 'PROHIBITED', reason: 'SSH credential modification' },
  { re: /\b(printenv|env)\b(?!\s+[A-Z_]+=)\s*$|\bset\s*$|\bexport\s*-p\b/, class: 'PROHIBITED', reason: 'dumps the environment, which may contain secrets' },
  { re: /\bcat\b[^|;]*\.(pem|key|p12|pfx)\b|id_rsa|id_ed25519/, class: 'PROHIBITED', reason: 'reads a private key' },
  { re: /\b(iptables|ufw|firewall-cmd|setenforce)\b/, class: 'PROHIBITED', reason: 'firewall or security policy change' },

  // ---- destructive
  { re: /\brm\b[^|;]*\s-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\b[^|;]*\s-[a-zA-Z]*f[a-zA-Z]*[rR]/, class: 'DESTRUCTIVE', reason: 'recursive force delete' },
  { re: /\bgit\b[^|;]*\bpush\b[^|;]*(--force\b|--force-with-lease\b|\s-f\b)/, class: 'DESTRUCTIVE', reason: 'force push rewrites published history' },
  { re: /\bgit\b[^|;]*\b(reset\s+--hard|clean\s+-[a-zA-Z]*[dfx])/, class: 'DESTRUCTIVE', reason: 'discards uncommitted work' },
  { re: /\b(drop|truncate)\s+(database|table|schema)\b/i, class: 'DESTRUCTIVE', reason: 'destructive database statement' },
  { re: /\b(mkfs|fdisk|parted)\b|\bdd\b[^|;]*\bof=\/dev\//, class: 'DESTRUCTIVE', reason: 'writes to a block device' },
  { re: /\bgit\b[^|;]*\bbranch\b[^|;]*\s-D\b|\bgh\b[^|;]*\brepo\s+delete\b/, class: 'DESTRUCTIVE', reason: 'deletes a branch or repository' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, class: 'DESTRUCTIVE', reason: 'host power state change' },
  { re: /\bchown\b|\bchmod\b\s+(777|-R\s+777)/, class: 'DESTRUCTIVE', reason: 'ownership or broad permission change' },

  // ---- external side effects
  { re: /\bgit\b[^|;]*\bpush\b/, class: 'EXTERNAL_SIDE_EFFECT', reason: 'publishes commits to a remote' },
  { re: /\bnpm\b[^|;]*\bpublish\b|\byarn\b[^|;]*\bpublish\b|\bpnpm\b[^|;]*\bpublish\b|\btwine\b[^|;]*\bupload\b|\bcargo\b[^|;]*\bpublish\b/, class: 'EXTERNAL_SIDE_EFFECT', reason: 'publishes a package' },
  { re: /\b(gcloud|aws|az|terraform|kubectl|helm|flyctl|heroku|vercel|netlify)\b/, class: 'EXTERNAL_SIDE_EFFECT', reason: 'cloud or cluster operation' },
  { re: /\bdocker\b[^|;]*\b(push|login)\b/, class: 'EXTERNAL_SIDE_EFFECT', reason: 'container registry operation' },
  { re: /\bssh\b\s+\S|\bscp\b|\brsync\b[^|;]*::|\brsync\b[^|;]*\S+:/, class: 'EXTERNAL_SIDE_EFFECT', reason: 'acts on a remote machine' },
  { re: /\b(curl|wget|http|httpie)\b[^|;]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|--upload-file|-d\s)/i, class: 'EXTERNAL_SIDE_EFFECT', reason: 'sends data to a remote service' },
  { re: /\b(sendmail|mail|mailx|msmtp)\b/, class: 'EXTERNAL_SIDE_EFFECT', reason: 'sends email' },
  { re: /\bsystemctl\b[^|;]*\b(start|stop|restart|enable|disable)\b/, class: 'EXTERNAL_SIDE_EFFECT', reason: 'changes a system service' },
  { re: /\bgit\b[^|;]*\btag\b[^|;]*\s-d\b|\bgh\b[^|;]*\b(release|pr|issue)\s+(create|delete|merge)\b/, class: 'EXTERNAL_SIDE_EFFECT', reason: 'changes remote repository state' },

  // ---- local but mutating
  { re: /\b(npm|pnpm|yarn|pip|pip3|poetry|uv|cargo|go|bundle)\b[^|;]*\b(install|add|i|sync|get)\b/, class: 'LOCAL_REVERSIBLE', reason: 'package install (may run install scripts)' },
  { re: /\bgit\b[^|;]*\b(commit|add|merge|rebase|checkout|switch|stash|restore|apply|cherry-pick)\b/, class: 'LOCAL_REVERSIBLE', reason: 'local git operation' },
  { re: /\b(mkdir|touch|mv|cp|ln|sed\s+-i|tee|truncate)\b/, class: 'LOCAL_REVERSIBLE', reason: 'modifies files' },
  { re: /\brm\b/, class: 'LOCAL_REVERSIBLE', reason: 'deletes files' },
  { re: /\b(make|cmake|gradle|gradlew|mvn|tsc|webpack|vite|next|esbuild)\b/, class: 'LOCAL_REVERSIBLE', reason: 'build step' },
  { re: /\b(npm|pnpm|yarn)\b[^|;]*\b(run|test|exec)\b|\b(pytest|vitest|jest|mocha|go\s+test|cargo\s+test)\b/, class: 'LOCAL_REVERSIBLE', reason: 'runs project scripts or tests' },

  // ---- read-only
  { re: /\bgit\b[^|;]*\b(status|diff|log|show|branch|remote|rev-parse|describe|blame|ls-files)\b/, class: 'READ_ONLY', reason: 'git inspection' },
  { re: /^\s*(ls|cat|head|tail|grep|rg|find|fd|wc|file|stat|pwd|which|whoami|date|df|du|ps|top|uname|echo|jq|sort|uniq|tree|less|diff)\b/, class: 'READ_ONLY', reason: 'inspection command' },
];

/** Split a shell command into independently-classified segments. */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];

  // Command substitutions are separate commands; pull them out and classify
  // them too, rather than letting them hide inside an innocuous-looking line.
  let remaining = command;
  for (const match of command.matchAll(SUBSTITUTION)) {
    const inner = match[1] ?? match[2] ?? match[3];
    if (inner && inner.trim() !== '') segments.push(inner.trim());
  }
  remaining = remaining.replace(SUBSTITUTION, ' ');

  for (const part of remaining.split(COMMAND_SEPARATORS)) {
    const trimmed = part?.trim();
    if (trimmed) segments.push(trimmed);
  }
  return segments.length > 0 ? segments : [command.trim()];
}

function classifyBashSegment(segment: string): { class: PermissionClass; reason: string } {
  for (const rule of BASH_RULES) {
    if (rule.re.test(segment)) return { class: rule.class, reason: rule.reason };
  }
  // Unrecognised commands are NOT assumed safe. Local-reversible is the floor
  // because an unknown binary can certainly write files.
  return { class: 'LOCAL_REVERSIBLE', reason: 'unrecognised command' };
}

export function classifyBashCommand(command: string): { class: PermissionClass; reason: string } {
  const segments = splitShellSegments(command);
  let worst: PermissionClass = 'READ_ONLY';
  let reason = 'inspection command';
  for (const segment of segments) {
    const result = classifyBashSegment(segment);
    if (CLASS_SEVERITY[result.class] > CLASS_SEVERITY[worst]) {
      worst = result.class;
      reason = result.reason;
    }
  }
  return { class: worst, reason };
}

/**
 * Paths that are routinely referenced by ordinary build/test commands and are
 * not interesting to protect. Keeping this list small and read-only-ish avoids
 * drowning the user in approval prompts for `/usr/bin/env`.
 */
const BENIGN_PATH_PREFIXES = [
  '/usr/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib64/',
  '/opt/',
  '/proc/',
  '/sys/',
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/etc/ssl/',
  '/tmp/',
  '/var/tmp/',
];

/** Locations whose contents are credentials or system control surfaces. */
const SENSITIVE_PATH_PATTERN =
  /(\/\.ssh\/|\/\.aws\/|\/\.gnupg\/|\/\.config\/gcloud|\/\.kube\/|authorized_keys|id_rsa|id_ed25519|\/etc\/(shadow|passwd|sudoers)|\/root\/|\.pem$|\.p12$|\.pfx$|(^|\/)\.env(\.|$))/;

/**
 * Pull filesystem paths out of a shell command.
 *
 * This is a heuristic, not a shell parser: it finds absolute and `~` paths in
 * argument position. It exists because a Bash call can otherwise touch any file
 * on the machine while being classified purely on its verb, which would let
 * `cat /home/other/private/notes` through as an "inspection command". The
 * worker's own permission layer remains the second line of defence.
 */
export function extractBashPaths(command: string): string[] {
  const paths: string[] = [];
  const pattern = /(?:^|[\s"'=:(])((?:~|\/)[A-Za-z0-9._~\-\/]*)/g;
  for (const match of command.matchAll(pattern)) {
    const candidate = match[1];
    if (candidate === undefined || candidate.length < 2) continue;
    paths.push(candidate);
  }
  return paths;
}

function isBenignPath(path: string): boolean {
  return BENIGN_PATH_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix));
}

/**
 * Escalate a Bash command's class when it references files outside the
 * permitted scope. Sensitive targets are refused outright; anything else merely
 * needs approval rather than being blocked, so ordinary work is not disrupted.
 */
function escalateForBashPaths(
  command: string,
  scope: FilesystemScope,
  base: { class: PermissionClass; reason: string },
): { class: PermissionClass; reason: string } {
  let result = base;
  for (const rawPath of extractBashPaths(command)) {
    if (SENSITIVE_PATH_PATTERN.test(rawPath)) {
      return { class: 'PROHIBITED', reason: `references a sensitive location (${rawPath})` };
    }
    if (isBenignPath(rawPath)) continue;
    if (rawPath.startsWith('~')) {
      return { class: 'PROHIBITED', reason: `references the home directory outside the project (${rawPath})` };
    }
    if (!scope.check(rawPath, 'read').allowed) {
      result = {
        class: maxClass(result.class, 'EXTERNAL_SIDE_EFFECT'),
        reason: `touches a path outside the permitted project scope (${rawPath})`,
      };
    }
  }
  return result;
}

/** Best-effort extraction of filesystem paths a tool call would touch. */
export function extractPaths(toolName: string, input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ['file_path', 'path', 'notebook_path', 'filePath', 'target_file']) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') paths.push(value);
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    const value = input['path'];
    if (typeof value === 'string' && value !== '') paths.push(value);
  }
  return paths;
}

export interface ClassifyOptions {
  toolName: string;
  input: Record<string, unknown>;
  scope: FilesystemScope;
  /** Path the SDK reported as blocked, when it supplied one. */
  blockedPath?: string;
}

export function classifyToolCall(options: ClassifyOptions): PermissionClassification {
  const { toolName, input, scope } = options;
  const paths = extractPaths(toolName, input);
  if (options.blockedPath) paths.push(options.blockedPath);

  // MCP tools from other servers are opaque to us. Treat them as external.
  if (toolName.startsWith('mcp__')) {
    return {
      class: 'EXTERNAL_SIDE_EFFECT',
      reason: 'tool provided by another MCP server; effects are not inspectable here',
      summary: `Use MCP tool ${toolName}`,
      ...(paths.length > 0 ? { paths } : {}),
    };
  }

  if (toolName === 'Bash' || toolName === 'BashCommand') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    const { class: cls, reason } = escalateForBashPaths(command, scope, classifyBashCommand(command));
    return {
      class: cls,
      reason,
      summary: `Run: ${redactText(command).slice(0, 200)}`,
      ...(paths.length > 0 ? { paths } : {}),
    };
  }

  if (WRITE_TOOLS.has(toolName)) {
    // A write outside the permitted scope is not merely "destructive"; it is
    // outside what this system is allowed to do at all.
    for (const path of paths) {
      const decision = scope.check(path, 'write');
      if (!decision.allowed) {
        return {
          class: 'PROHIBITED',
          reason: decision.reason ?? 'write outside permitted filesystem scope',
          summary: `Write to ${path}`,
          paths,
        };
      }
    }
    return {
      class: 'LOCAL_REVERSIBLE',
      reason: 'edits a file inside the project',
      summary: `${toolName} ${paths[0] ?? '(file)'}`,
      ...(paths.length > 0 ? { paths } : {}),
    };
  }

  if (READ_ONLY_TOOLS.has(toolName)) {
    for (const path of paths) {
      const decision = scope.check(path, 'read');
      if (!decision.allowed) {
        return {
          class: 'PROHIBITED',
          reason: decision.reason ?? 'read outside permitted filesystem scope',
          summary: `Read ${path}`,
          paths,
        };
      }
    }
    return {
      class: 'READ_ONLY',
      reason: 'inspection only',
      summary: `${toolName}${paths[0] ? ` ${paths[0]}` : ''}`,
      ...(paths.length > 0 ? { paths } : {}),
    };
  }

  return {
    class: 'LOCAL_REVERSIBLE',
    reason: `unrecognised tool "${toolName}"`,
    summary: `Use ${toolName}`,
    ...(paths.length > 0 ? { paths } : {}),
  };
}
