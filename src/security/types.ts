/** Shape the filesystem scope needs, decoupled from the full config object. */
export interface FilesystemScopeConfig {
  projectRoots: string[];
  additionalReadablePaths: string[];
  deniedPaths: string[];
  allowOutsideProjectRead: boolean;
  allowOutsideProjectWrite: boolean;
}
