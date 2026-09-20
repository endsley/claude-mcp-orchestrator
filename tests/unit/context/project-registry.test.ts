import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../../../src/services/projects/project-registry.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-projects-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'home-dash'));
  await mkdir(join(root, 'transit-one'));
  await mkdir(join(root, 'transit-two'));
  await writeFile(join(root, 'home-dash', 'package.json'), JSON.stringify({ name: 'home-dash', dependencies: { react: '^1' } }));
  await writeFile(join(root, 'transit-one', 'pyproject.toml'), '[project]\nname="transit-one"\n');
  await writeFile(join(root, 'transit-two', 'README.md'), '# Transit two\n');
  return root;
}

describe('ProjectRegistry', () => {
  it('discovers only configured roots and resolves declared natural aliases', async () => {
    const root = await projectRoot();
    const registry = new ProjectRegistry({
      roots: [root],
      defaultComputerId: 'tailscale:self',
      metadata: { [join(root, 'home-dash')]: { displayName: 'HomeDash', aliases: ['home dash', 'my homepage'] } },
    });
    const projects = await registry.list();
    expect(projects.map((project) => project.displayName)).toEqual(expect.arrayContaining(['HomeDash', 'transit-one', 'transit-two']));
    expect(projects.find((project) => project.displayName === 'HomeDash')?.framework).toBe('react');
    const match = await registry.resolve('MY HOMEPAGE');
    expect(match.kind).toBe('match');
    expect(match.project?.displayName).toBe('HomeDash');
  });

  it('keeps ambiguity first class rather than guessing between similarly named projects', async () => {
    const root = await projectRoot();
    const registry = new ProjectRegistry({
      roots: [root],
      defaultComputerId: 'tailscale:self',
      metadata: {
        [join(root, 'transit-one')]: { aliases: ['transit app'] },
        [join(root, 'transit-two')]: { aliases: ['transit app'] },
      },
    });
    const resolution = await registry.resolve('transit app');
    expect(resolution.kind).toBe('ambiguous');
    expect(resolution.candidates).toHaveLength(2);
  });
});
