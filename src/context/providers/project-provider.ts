import type { InitialContextProvider, InitialContextRequest, InitialContextSection, ProviderHealth } from '../contracts.js';
import type { Project } from '../../services/projects/types.js';
import type { ProjectRegistry } from '../../services/projects/project-registry.js';

function compactProject(project: Project): string {
  const tech = [project.language, project.framework].filter(Boolean).join(' / ');
  const details = [project.git?.branch, project.git?.dirty ? 'uncommitted changes' : undefined].filter(
    (part): part is string => Boolean(part),
  );
  // The GitHub repo and a one-line purpose are what make a bare directory name
  // usable in conversation: without them the model cannot tell which of nearly
  // thirty similarly-named directories the user means by "the transit app".
  const repo = project.git?.remote;
  return (
    `${project.displayName}` +
    `${tech ? ` — ${tech}` : ''}` +
    `${details.length > 0 ? ` (${details.join(', ')})` : ''}` +
    `${repo ? ` [${repo}]` : ''}` +
    `${project.description ? `\n    ${project.description}` : ''}`
  );
}

export class ProjectContextProvider implements InitialContextProvider {
  readonly id = 'projects';
  readonly description = 'Configured local development projects, Git state, aliases, and Claude instruction presence.';
  readonly priority = 90;
  readonly defaultEnabled = true;

  constructor(private readonly projects: ProjectRegistry) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getContext(request: InitialContextRequest): Promise<InitialContextSection | null> {
    const all = await this.projects.list();
    const projectId = typeof request.options.projectId === 'string' ? request.options.projectId : undefined;
    const selected = projectId === undefined ? all : all.filter((project) => project.id === projectId);
    if (all.length === 0) {
      return {
        providerId: this.id,
        title: 'Projects',
        lines: ['No projects are currently discovered under configured project roots.'],
        generatedAt: new Date().toISOString(),
      };
    }
    const shown = (selected.length > 0 ? selected : all).slice(0, 12);
    const lines = [`${all.length} discovered projects.`, ...shown.map(compactProject)];
    return {
      providerId: this.id,
      title: 'Projects',
      lines,
      minLines: 1,
      generatedAt: new Date().toISOString(),
    };
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const projects = await this.projects.list();
      return { status: 'ok', checkedAt, detail: `${projects.length} projects indexed.` };
    } catch {
      return { status: 'degraded', checkedAt, detail: 'Project roots could not be fully scanned.' };
    }
  }
}
