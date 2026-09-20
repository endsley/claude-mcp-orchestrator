import type { InitialContextProvider, InitialContextRequest, InitialContextSection, ProviderHealth } from '../contracts.js';
import type { Computer } from '../../services/tailscale/types.js';
import type { ComputerService } from '../../services/tailscale/computer-service.js';

function compactComputer(computer: Computer): string {
  const state = computer.tailscale.online ? (computer.tailscale.reachable ? 'online and active' : 'online') : 'offline';
  const role = computer.role ? ` — ${computer.role}` : '';
  const route = computer.tailscale.connectionType === 'unknown' ? '' : ` (${computer.tailscale.connectionType})`;
  return `${computer.displayName} [${computer.machineName}]${role} — ${state}${route}`;
}

export class ComputerContextProvider implements InitialContextProvider {
  readonly id = 'computers';
  readonly description = 'Known Tailscale computers, configured aliases, and live availability.';
  readonly priority = 100;
  readonly defaultEnabled = true;

  constructor(private readonly computers: ComputerService) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.computers.list();
      return true;
    } catch {
      return false;
    }
  }

  async getContext(request: InitialContextRequest): Promise<InitialContextSection | null> {
    const all = await this.computers.list();
    if (all.length === 0) return null;
    const computerId = typeof request.options.computerId === 'string' ? request.options.computerId : undefined;
    const selected = computerId === undefined ? all : all.filter((computer) => computer.id === computerId);
    const shown = (selected.length > 0 ? selected : all).slice(0, 12);
    const online = all.filter((computer) => computer.tailscale.online).length;
    const lines = [`${all.length} known computers; ${online} online.`, ...shown.map(compactComputer)];
    return {
      providerId: this.id,
      title: 'Computers',
      lines,
      minLines: 1,
      generatedAt: new Date().toISOString(),
    };
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const computers = await this.computers.list();
      return { status: 'ok', checkedAt, detail: `${computers.length} computers discovered.` };
    } catch {
      return { status: 'unavailable', checkedAt, detail: 'Tailscale inventory unavailable.' };
    }
  }
}
