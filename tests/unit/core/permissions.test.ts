import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { FilesystemScope } from '../../../src/security/paths.js';
import { classifyBashCommand, classifyToolCall, maxClass, splitShellSegments } from '../../../src/security/permissions.js';

const scope = new FilesystemScope({
  projectRoots: ['/tmp/project'],
  additionalReadablePaths: ['/etc/claude'],
  deniedPaths: ['/tmp/project/.secrets'],
  allowOutsideProjectRead: false,
  allowOutsideProjectWrite: false,
});

describe('classifyBashCommand', () => {
  it('treats inspection commands as read-only', () => {
    expect(classifyBashCommand('ls -la').class).toBe('READ_ONLY');
    expect(classifyBashCommand('git status').class).toBe('READ_ONLY');
    expect(classifyBashCommand('git diff HEAD').class).toBe('READ_ONLY');
  });

  it('treats ordinary development as locally reversible', () => {
    expect(classifyBashCommand('npm run build').class).toBe('LOCAL_REVERSIBLE');
    expect(classifyBashCommand('npm test').class).toBe('LOCAL_REVERSIBLE');
    expect(classifyBashCommand('git commit -m "wip"').class).toBe('LOCAL_REVERSIBLE');
  });

  it('flags external side effects', () => {
    expect(classifyBashCommand('git push origin main').class).toBe('EXTERNAL_SIDE_EFFECT');
    expect(classifyBashCommand('npm publish').class).toBe('EXTERNAL_SIDE_EFFECT');
    expect(classifyBashCommand('gcloud run deploy svc').class).toBe('EXTERNAL_SIDE_EFFECT');
    expect(classifyBashCommand('curl -X POST https://example.com -d @body').class).toBe('EXTERNAL_SIDE_EFFECT');
  });

  it('flags destructive commands', () => {
    expect(classifyBashCommand('rm -rf /home/user/stuff').class).toBe('DESTRUCTIVE');
    expect(classifyBashCommand('git push --force origin main').class).toBe('DESTRUCTIVE');
    expect(classifyBashCommand('DROP TABLE users').class).toBe('DESTRUCTIVE');
    expect(classifyBashCommand('git reset --hard HEAD~3').class).toBe('DESTRUCTIVE');
  });

  it('prohibits privilege escalation and secret exposure', () => {
    expect(classifyBashCommand('sudo systemctl restart nginx').class).toBe('PROHIBITED');
    expect(classifyBashCommand('cat ~/.ssh/id_rsa').class).toBe('PROHIBITED');
    expect(classifyBashCommand('echo key >> ~/.ssh/authorized_keys').class).toBe('PROHIBITED');
  });

  // The whole point of segment splitting: a harmless prefix must not launder
  // a dangerous suffix past the classifier.
  it('classifies by the WORST segment, not the first', () => {
    expect(classifyBashCommand('ls && rm -rf /important').class).toBe('DESTRUCTIVE');
    expect(classifyBashCommand('echo hi; sudo rm -rf /').class).toBe('PROHIBITED');
    expect(classifyBashCommand('cat file.txt | git push --force').class).toBe('DESTRUCTIVE');
  });

  it('looks inside command substitutions', () => {
    expect(classifyBashCommand('echo $(sudo cat /etc/shadow)').class).toBe('PROHIBITED');
    expect(classifyBashCommand('echo `git push --force`').class).toBe('DESTRUCTIVE');
  });

  it('defaults unknown commands to locally reversible rather than read-only', () => {
    expect(classifyBashCommand('some-unknown-binary --flag').class).toBe('LOCAL_REVERSIBLE');
  });
});

describe('splitShellSegments', () => {
  it('splits on shell control operators', () => {
    expect(splitShellSegments('a && b || c ; d | e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('returns the original when there is nothing to split', () => {
    expect(splitShellSegments('ls -la')).toEqual(['ls -la']);
  });
});

describe('classifyToolCall', () => {
  it('allows reads and writes inside the project', () => {
    expect(classifyToolCall({ toolName: 'Read', input: { file_path: '/tmp/project/a.ts' }, scope }).class).toBe('READ_ONLY');
    expect(classifyToolCall({ toolName: 'Write', input: { file_path: '/tmp/project/a.ts' }, scope }).class).toBe('LOCAL_REVERSIBLE');
  });

  it('prohibits writes outside the project roots', () => {
    const result = classifyToolCall({ toolName: 'Write', input: { file_path: '/etc/passwd' }, scope });
    expect(result.class).toBe('PROHIBITED');
  });

  it('prohibits reads of a denied path even inside a project root', () => {
    const result = classifyToolCall({ toolName: 'Read', input: { file_path: '/tmp/project/.secrets/key' }, scope });
    expect(result.class).toBe('PROHIBITED');
  });

  it('treats third-party MCP tools as external side effects', () => {
    expect(classifyToolCall({ toolName: 'mcp__github__create_pr', input: {}, scope }).class).toBe('EXTERNAL_SIDE_EFFECT');
  });

  it('redacts secrets out of the summary it produces', () => {
    const result = classifyToolCall({
      toolName: 'Bash',
      input: { command: 'deploy --token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' },
      scope,
    });
    expect(result.summary).not.toContain('ghp_ABCDEF');
  });
});

describe('maxClass', () => {
  it('returns the more dangerous of two classes', () => {
    expect(maxClass('READ_ONLY', 'DESTRUCTIVE')).toBe('DESTRUCTIVE');
    expect(maxClass('PROHIBITED', 'EXTERNAL_SIDE_EFFECT')).toBe('PROHIBITED');
    expect(maxClass('READ_ONLY', 'READ_ONLY')).toBe('READ_ONLY');
  });
});

/**
 * Scope escapes found by an independent review (endsley/bodhi-inbox#30), all
 * four reproduced against the real classifier before being fixed. They share a
 * single shape: the scope check and whatever finally opens the file disagreed
 * about what a string means. A path is only as guarded as that agreement.
 *
 * The service runs with its working directory set to the repository, which is
 * itself a project root, so these were live rather than theoretical.
 */
describe('paths the scope check used to misread', () => {
  /**
   * The project root MUST be the process's working directory for the tilde
   * cases to mean anything. resolve('~/x') is cwd-relative, so with a root of
   * /tmp/project the path lands outside it and is refused for a reason that has
   * nothing to do with the bug -- the test then passes with the fix reverted.
   * The service runs with WorkingDirectory set to the repository, which is a
   * project root, so this is also the real deployment shape.
   */
  const cwdScope = new FilesystemScope({
    projectRoots: [process.cwd()],
    additionalReadablePaths: [],
    deniedPaths: [],
    allowOutsideProjectRead: false,
    allowOutsideProjectWrite: false,
  });

  it('confirms the harness actually reproduces the escape', () => {
    // If this ever fails, the tilde tests below have stopped testing anything.
    expect(resolve('~/.ssh/authorized_keys').startsWith(process.cwd())).toBe(true);
  });

  it('refuses a write to the home directory written as ~', () => {
    // resolve() treats ~ as an ordinary directory name, so this became
    // <cwd>/~/.ssh/authorized_keys -- lexically inside the project -- and was
    // classified LOCAL_REVERSIBLE and auto-allowed. The tool downstream then
    // expands ~ for real. Writing authorized_keys is persistence, not a leak.
    const decision = classifyToolCall({ toolName: 'Write', input: { file_path: '~/.ssh/authorized_keys' }, scope: cwdScope });
    expect(decision.class).toBe('PROHIBITED');
  });

  it('refuses reads of the home directory written as ~', () => {
    expect(classifyToolCall({ toolName: 'Read', input: { file_path: '~/.aws/credentials' }, scope: cwdScope }).class).toBe('PROHIBITED');
    expect(classifyToolCall({ toolName: 'Edit', input: { file_path: '~/.bashrc' }, scope: cwdScope }).class).toBe('PROHIBITED');
  });

  it('refuses another user\'s home rather than guessing at it', () => {
    // ~root cannot be resolved without /etc/passwd, and treating it as a
    // literal directory name is the bug above.
    const decision = classifyToolCall({ toolName: 'Read', input: { file_path: '~root/.ssh/id_rsa' }, scope: cwdScope });
    expect(decision.class).toBe('PROHIBITED');
    expect(decision.reason).toMatch(/cannot resolve/i);
  });

  it('does not auto-allow a relative path that climbs out of the project', () => {
    // extractBashPaths matches only absolute and ~ paths, so this yielded NO
    // paths and was classified READ_ONLY on the verb alone. The worker's cwd is
    // the project directory, so any .. segment may leave it.
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'cat ../../../../etc/passwd' }, scope }).class).toBe('PROHIBITED');

    const sibling = classifyToolCall({ toolName: 'Bash', input: { command: 'cd ../sibling && npm test' }, scope });
    // Not refused -- leaving the project may be legitimate -- but not silent.
    expect(sibling.class).toBe('EXTERNAL_SIDE_EFFECT');
  });

  it('does not auto-allow a path built from a shell variable', () => {
    // This classifier has no environment, so it cannot know what $HOME is. It
    // must therefore not pretend the command touches nothing.
    expect(classifyToolCall({ toolName: 'Bash', input: { command: "awk '{print}' $HOME/.gnupg/secring.gpg" }, scope }).class).toBe('PROHIBITED');

    for (const command of ['cat ${HOME}/.netrc', 'cat $XDG_CONFIG_HOME/private']) {
      expect(classifyToolCall({ toolName: 'Bash', input: { command }, scope }).class).toBe('EXTERNAL_SIDE_EFFECT');
    }
  });

  it('refuses the per-process /proc tree while keeping /proc/cpuinfo usable', () => {
    // /proc/ was on the benign prefix list, so /proc/self/environ -- every
    // token this process holds -- was READ_ONLY and auto-allowed, while the
    // explicit rule on `env` called the same information PROHIBITED.
    for (const command of ['cat /proc/self/environ', 'cat /proc/1/environ', 'cat /proc/self/cmdline']) {
      expect(classifyToolCall({ toolName: 'Bash', input: { command }, scope }).class).toBe('PROHIBITED');
    }
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'cat /proc/cpuinfo' }, scope }).class).toBe('READ_ONLY');
  });

  it('scope-checks a file:// URL, which is a filesystem read wearing a URL', () => {
    // WebFetch is READ_ONLY and takes `url`, not `file_path`, so nothing was
    // extracted and nothing was checked.
    expect(classifyToolCall({ toolName: 'WebFetch', input: { url: 'file:///etc/passwd' }, scope }).class).toBe('PROHIBITED');
    expect(classifyToolCall({ toolName: 'WebFetch', input: { url: 'https://example.com' }, scope }).class).toBe('READ_ONLY');
  });

  it('catches a sensitive location passed as a bare relative argument', () => {
    // `-C /` then a bare relative path. Extracting every bare relative token is
    // not possible -- in a shell command every word looks like one -- so the
    // whole command line is scanned and the call is escalated to approval.
    const decision = classifyToolCall({ toolName: 'Bash', input: { command: 'tar -czf /tmp/x.tgz -C / etc/shadow' }, scope });
    expect(decision.class).toBe('EXTERNAL_SIDE_EFFECT');
  });
});

/**
 * The counterweight. A permission layer that asks about everything gets its
 * approvals clicked through unread, so the ordinary commands an agent runs all
 * day must stay silent.
 */
describe('ordinary project work is not escalated', () => {
  it.each([
    ['npm test', 'LOCAL_REVERSIBLE'],
    ['npx vitest run', 'LOCAL_REVERSIBLE'],
    ['ls src/', 'READ_ONLY'],
    ['git status', 'READ_ONLY'],
    ['git log --oneline -5', 'READ_ONLY'],
    ['cat /proc/cpuinfo', 'READ_ONLY'],
    ['echo $PATH', 'READ_ONLY'],
    ['echo $(date)', 'READ_ONLY'],
  ])('%s stays %s', (command, expected) => {
    expect(classifyToolCall({ toolName: 'Bash', input: { command }, scope }).class).toBe(expected);
  });

  it('still allows work inside the project', () => {
    expect(classifyToolCall({ toolName: 'Write', input: { file_path: '/tmp/project/src/a.ts' }, scope }).class).toBe('LOCAL_REVERSIBLE');
    expect(classifyToolCall({ toolName: 'Read', input: { file_path: '/tmp/project/src/a.ts' }, scope }).class).toBe('READ_ONLY');
    // additionalReadablePaths still works.
    expect(classifyToolCall({ toolName: 'Read', input: { file_path: '/etc/claude/config.json' }, scope }).class).toBe('READ_ONLY');
  });
});
