import type { InitialContextProvider, InitialContextRequest, InitialContextSection, ProviderHealth, WorkSessionContextReader } from '../contracts.js';

export class WorkSessionContextProvider implements InitialContextProvider {
  readonly id = 'workSessions';
  readonly description = 'Active and recent Claude work-session summaries without raw transcripts.';
  readonly priority = 100;
  readonly defaultEnabled = true;

  constructor(private readonly sessions: WorkSessionContextReader) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getContext(_request: InitialContextRequest): Promise<InitialContextSection | null> {
    return this.sessions.getCompactActiveContext();
  }

  async health(): Promise<ProviderHealth> {
    return { status: 'ok', checkedAt: new Date().toISOString() };
  }
}
