import { describe, expect, it } from 'vitest';
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
