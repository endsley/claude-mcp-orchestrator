export type { Project, ProjectMetadata, ProjectGitState } from '../../types/projects.js';
import type { Project } from '../../types/projects.js';

export interface ProjectResolution {
  kind: 'match' | 'ambiguous' | 'not_found';
  project?: Project;
  candidates: Project[];
}
