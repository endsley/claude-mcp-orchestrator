export interface ProjectGitState {
  isRepo: boolean;
  branch?: string;
  /** True when the working tree has uncommitted changes. */
  dirty?: boolean;
  /** Short SHA of HEAD. */
  head?: string;
  remote?: string;
  /** ISO timestamp of the most recent commit. */
  lastCommitAt?: string;
  lastCommitSubject?: string;
}

export interface Project {
  /** Stable ID derived from the canonical absolute path, not the display name. */
  id: string;
  name: string;
  displayName: string;
  aliases: string[];
  /** Computer ID this project lives on. V1 only indexes the local machine. */
  computerId: string;
  path: string;
  /** Markers that caused this directory to be treated as a project. */
  markers: string[];
  language?: string;
  framework?: string;
  git?: ProjectGitState;
  hasClaudeMd: boolean;
  /** ISO timestamp of the most recent filesystem or git activity. */
  lastActivityAt?: string;
  /** Work session currently holding the write lock on this project, if any. */
  activeWorkSessionId?: string;
  description?: string;
}

/** Operator-authored project metadata, keyed by absolute path. */
export interface ProjectMetadata {
  displayName?: string;
  aliases?: string[];
  description?: string;
  /** Excludes the directory from discovery even if it sits under a root. */
  ignore?: boolean;
}

export interface ProjectIndexStats {
  projectCount: number;
  rootsScanned: string[];
  /** ISO timestamp of the last full or incremental refresh. */
  refreshedAt: string;
  lastScanDurationMs: number;
  warnings: string[];
}
