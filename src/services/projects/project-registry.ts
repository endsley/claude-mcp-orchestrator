import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, realpath, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { normalizeLookup, similarity } from '../../context/text.js';
import { orchestratorError } from '../../types/errors.js';
import type { Project, ProjectMetadata, ProjectResolution } from './types.js';
import type { ProjectGitState } from '../../types/projects.js';

const execFile = promisify(execFileCallback);

export interface ProjectRegistryOptions {
  roots: string[];
  metadata?: Record<string, ProjectMetadata>;
  defaultComputerId: string;
  cacheTtlMs?: number;
  maxProjectsPerRoot?: number;
  maxDepth?: number;
  ignoreDirs?: string[];
}

interface RegistryCache {
  projects: Project[];
  expiresAt: number;
}

interface PackageDescription {
  name?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

function stableProjectId(path: string): string {
  return `project:${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
}

function containsPath(root: string, child: string): boolean {
  const relation = relative(root, child);
  return relation === '' || (!relation.startsWith('..') && !relation.includes('/../'));
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function dependencyNames(pkg: PackageDescription): string[] {
  const collect = (value: unknown): string[] => typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : [];
  return [...collect(pkg.dependencies), ...collect(pkg.devDependencies)];
}

async function packageDetails(path: string): Promise<{ name?: string; language?: string; framework?: string }> {
  const file = join(path, 'package.json');
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { language: 'TypeScript/JavaScript' };
    const pkg = parsed as PackageDescription;
    const dependencies = dependencyNames(pkg);
    const framework = ['next', 'react', 'express', 'fastify', 'vite', 'svelte', 'vue', '@angular/core']
      .find((candidate) => dependencies.includes(candidate));
    const result: { name?: string; language?: string; framework?: string } = { language: 'TypeScript/JavaScript' };
    const name = nonBlank(pkg.name);
    if (name !== undefined) result.name = name;
    if (framework !== undefined) result.framework = framework;
    return result;
  } catch {
    return { language: 'TypeScript/JavaScript' };
  }
}

async function detectLanguage(path: string): Promise<{ language?: string; framework?: string; packageName?: string }> {
  const packageInfo = await packageDetails(path);
  if (packageInfo.language !== undefined) return { language: packageInfo.language, framework: packageInfo.framework, packageName: packageInfo.name };
  if (await readable(join(path, 'pyproject.toml')) || await readable(join(path, 'requirements.txt'))) return { language: 'Python' };
  if (await readable(join(path, 'Cargo.toml'))) return { language: 'Rust' };
  if (await readable(join(path, 'go.mod'))) return { language: 'Go' };
  if (await readable(join(path, 'build.gradle.kts')) || await readable(join(path, 'build.gradle'))) return { language: 'Kotlin/Java' };
  return {};
}

async function inspectGit(path: string): Promise<ProjectGitState> {
  try {
    const [{ stdout: statusOut }, { stdout: activityOut }] = await Promise.all([
      execFile('git', ['-C', path, 'status', '--porcelain=v1', '--branch'], { timeout: 2_000, maxBuffer: 128_000, encoding: 'utf8' }),
      execFile('git', ['-C', path, 'log', '-1', '--format=%cI'], { timeout: 2_000, maxBuffer: 8_000, encoding: 'utf8' }),
    ]);
    const lines = statusOut.split('\n').filter(Boolean);
    const header = lines[0] ?? '';
    const branch = /^## ([^ .]+)(?:\.\.\.)?/.exec(header)?.[1];
    const result: ProjectGitState = { isRepo: true, dirty: lines.length > 1 };
    if (branch !== undefined && branch !== 'HEAD') result.branch = branch;
    const lastActivity = activityOut.trim();
    if (lastActivity) result.lastCommitAt = lastActivity;
    return result;
  } catch {
    return { isRepo: false };
  }
}

async function isProjectCandidate(path: string): Promise<boolean> {
  const indicators = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'CLAUDE.md', 'README.md'];
  return (await Promise.all(indicators.map((indicator) => readable(join(path, indicator))))).some(Boolean);
}

async function markersAt(path: string): Promise<string[]> {
  const indicators = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'CLAUDE.md', 'README.md'];
  const states = await Promise.all(indicators.map(async (indicator) => (await readable(join(path, indicator)) ? indicator : null)));
  return states.flatMap((indicator) => indicator === null ? [] : [indicator]);
}

/**
 * Bounded project discovery: scan only configured roots and their immediate
 * children. It never walks an arbitrary home directory on a voice request.
 */
export class ProjectRegistry {
  private readonly roots: string[];
  private readonly metadata: Record<string, ProjectMetadata>;
  private readonly defaultComputerId: string;
  private readonly cacheTtlMs: number;
  private readonly maxProjectsPerRoot: number;
  private readonly maxDepth: number;
  private readonly ignoredDirs: Set<string>;
  private cache: RegistryCache | undefined;

  constructor(options: ProjectRegistryOptions) {
    this.roots = options.roots.map((root) => resolve(root));
    this.metadata = options.metadata ?? {};
    this.defaultComputerId = options.defaultComputerId;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 60_000);
    this.maxProjectsPerRoot = Math.max(1, options.maxProjectsPerRoot ?? 100);
    this.maxDepth = Math.max(1, Math.min(6, options.maxDepth ?? 1));
    this.ignoredDirs = new Set(options.ignoreDirs ?? ['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', 'target', 'vendor', '.pytest_cache']);
  }

  async list(forceRefresh = false): Promise<Project[]> {
    if (!forceRefresh && this.cache !== undefined && this.cache.expiresAt > Date.now()) {
      return this.cache.projects.map((project) => structuredClone(project));
    }
    const projects: Project[] = [];
    for (const configuredRoot of this.roots) {
      if (!existsSync(configuredRoot)) continue;
      let root: string;
      try {
        root = await realpath(configuredRoot);
      } catch {
        continue;
      }
      const candidates: string[] = [];
      const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
      while (queue.length > 0 && candidates.length < this.maxProjectsPerRoot) {
        const current = queue.shift()!;
        if (current.depth > 0) candidates.push(current.path);
        if (current.depth >= this.maxDepth) continue;
        let entries;
        try {
          entries = await readdir(current.path, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.') || this.ignoredDirs.has(entry.name)) continue;
          queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
        }
      }
      for (const candidate of candidates) {
        let path: string;
        try {
          path = await realpath(candidate);
        } catch {
          continue;
        }
        if (!containsPath(root, path) || !(await isProjectCandidate(path))) continue;
        const metadata = this.metadata[path] ?? this.metadata[basename(path)];
        if (metadata?.ignore) continue;
        projects.push(await this.toProject(path));
      }
    }
    const unique = [...new Map(projects.map((project) => [project.path, project])).values()]
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    this.cache = { projects: unique, expiresAt: Date.now() + this.cacheTtlMs };
    return unique.map((project) => structuredClone(project));
  }

  async get(idOrPath: string): Promise<Project> {
    const resolution = await this.resolve(idOrPath);
    if (resolution.kind === 'match' && resolution.project !== undefined) return resolution.project;
    if (resolution.kind === 'ambiguous') {
      throw orchestratorError('PROJECT_AMBIGUOUS', `More than one project matches '${idOrPath}'.`, {
        details: { candidates: resolution.candidates.map((project) => ({ id: project.id, name: project.displayName })) },
      });
    }
    throw orchestratorError('PROJECT_NOT_FOUND', `No configured project matches '${idOrPath}'.`, { details: { query: idOrPath } });
  }

  async resolve(query: string, computerId?: string): Promise<ProjectResolution> {
    const normalizedQuery = normalizeLookup(query);
    if (!normalizedQuery) return { kind: 'not_found', candidates: [] };
    const projects = (await this.list()).filter((project) => computerId === undefined || project.computerId === computerId);
    const scored = projects.map((project) => {
      const labels = [project.id, project.name, project.displayName, project.path, ...project.aliases];
      return {
        project,
        exact: labels.some((label) => normalizeLookup(label) === normalizedQuery),
        score: Math.max(...labels.map((label) => similarity(normalizedQuery, label))),
      };
    }).sort((left, right) => right.score - left.score);
    const exact = scored.filter((entry) => entry.exact);
    if (exact.length === 1) return { kind: 'match', project: exact[0]!.project, candidates: [] };
    if (exact.length > 1) return { kind: 'ambiguous', candidates: exact.map((entry) => entry.project) };
    const best = scored[0];
    const next = scored[1];
    if (best !== undefined && best.score >= 0.78 && (next === undefined || best.score - next.score >= 0.16)) {
      return { kind: 'match', project: best.project, candidates: [] };
    }
    const candidates = scored.filter((entry) => entry.score >= 0.55).slice(0, 5).map((entry) => entry.project);
    return candidates.length ? { kind: 'ambiguous', candidates } : { kind: 'not_found', candidates: [] };
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private async toProject(path: string): Promise<Project> {
    const metadata = this.metadata[path] ?? this.metadata[basename(path)] ?? {};
    const detected = await detectLanguage(path);
    const canonicalName = detected.packageName ?? basename(path);
    const project: Project = {
      id: stableProjectId(path),
      name: canonicalName,
      displayName: metadata.displayName?.trim() || canonicalName,
      aliases: [...new Set((metadata.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))],
      computerId: this.defaultComputerId,
      path,
      markers: await markersAt(path),
      git: await inspectGit(path),
      hasClaudeMd: await readable(join(path, 'CLAUDE.md')),
    };
    if (detected.language !== undefined) project.language = detected.language;
    if (detected.framework !== undefined) project.framework = detected.framework;
    return project;
  }
}
