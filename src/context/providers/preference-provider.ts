import type { InitialContextProvider, InitialContextRequest, InitialContextSection, ProviderHealth } from '../contracts.js';

/**
 * This provider intentionally carries only a safe operational summary. Claude
 * Code remains the single authority for user/project/local instructions.
 */
export class PreferenceContextProvider implements InitialContextProvider {
  readonly id = 'preferences';
  readonly description = 'A compact map of where existing Claude Code preferences and instructions are loaded.';
  readonly priority = 80;
  readonly defaultEnabled = true;

  constructor(private readonly summaries: string[] = [
    'Computer-side Claude loads the existing user, project, and local Claude configuration.',
    'Project CLAUDE.md, .claude rules/skills/settings, and configured MCP integrations remain authoritative.',
  ]) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getContext(_request: InitialContextRequest): Promise<InitialContextSection> {
    return {
      providerId: this.id,
      title: 'Existing Claude Preferences',
      lines: this.summaries,
      minLines: 1,
      generatedAt: new Date().toISOString(),
    };
  }

  async health(): Promise<ProviderHealth> {
    return { status: 'ok', checkedAt: new Date().toISOString() };
  }
}
