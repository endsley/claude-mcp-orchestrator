import { orchestratorError } from '../../types/errors.js';
import { normalizeLookup, similarity } from '../../context/text.js';
import type { TailscaleClient } from './tailscale-client.js';
import type {
  Computer,
  ComputerMetadata,
  ComputerResolution,
  ConnectionType,
  TailscaleMachineRaw,
  TailscaleStatusRaw,
} from './types.js';

export interface ComputerInventoryOptions {
  metadata?: Record<string, ComputerMetadata>;
  cacheTtlMs?: number;
}

interface CacheEntry {
  computers: Computer[];
  expiresAt: number;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function addresses(raw: TailscaleMachineRaw): { ipv4?: string; ipv6?: string } {
  const ips = Array.isArray(raw.TailscaleIPs) ? raw.TailscaleIPs : [];
  const ipv4 = ips.find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
  const ipv6 = ips.find((ip) => ip.includes(':'));
  const output: { ipv4?: string; ipv6?: string } = {};
  if (ipv4 !== undefined) output.ipv4 = ipv4;
  if (ipv6 !== undefined) output.ipv6 = ipv6;
  return output;
}

/**
 * Directness is intentionally conservative: only a concrete current peer
 * address grants "direct". Online devices without route data remain unknown.
 */
export function connectionType(raw: TailscaleMachineRaw): ConnectionType {
  if (raw.Online !== true) return 'idle';
  if (nonBlank(raw.CurAddr) !== undefined) return 'direct';
  if (nonBlank(raw.Relay) !== undefined) return 'relay';
  return 'unknown';
}

export function normalizeTailscaleStatus(status: TailscaleStatusRaw, metadata: Record<string, ComputerMetadata> = {}): Computer[] {
  const peers = Array.isArray(status.Peer) ? status.Peer : Object.values(status.Peer ?? {});
  const machines = [status.Self, ...peers].filter((item): item is TailscaleMachineRaw => item !== undefined);
  const seen = new Set<string>();
  return machines.flatMap((raw) => {
    // The Tailscale MACHINE NAME is the first label of DNSName - it is what
    // `tailscale status` prints and what the user says out loud. HostName is
    // the device's OS hostname, which on Windows is often something generic
    // like "Guest"; using it made the machine the user calls "laptop"
    // unresolvable and displayed it to them under a name they never chose.
    const osHostName = nonBlank(raw.HostName);
    const dnsLabel = nonBlank(raw.DNSName)?.split('.')[0];
    const machineName = nonBlank(dnsLabel) ?? osHostName;
    if (machineName === undefined) return [];
    const id = `tailscale:${nonBlank(raw.StableID) ?? nonBlank(raw.ID) ?? machineName.toLocaleLowerCase()}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const metadataKey = [
      machineName,
      machineName.toLocaleLowerCase(),
      osHostName,
      osHostName?.toLocaleLowerCase(),
    ].find((key) => key !== undefined && metadata[key] !== undefined);
    const extra = metadataKey === undefined ? {} : metadata[metadataKey]!;
    const isSelf = raw === status.Self;
    const tailscale: Computer['tailscale'] = {
      ...addresses(raw),
      // Self has no peer path. Its Relay field describes local transport state,
      // not a meaningful connection *to itself* for voice reporting.
      connectionType: isSelf ? 'unknown' : connectionType(raw),
    };
    const dnsName = nonBlank(raw.DNSName);
    const lastSeen = nonBlank(raw.LastSeen);
    if (dnsName !== undefined) tailscale.dnsName = dnsName;
    if (typeof raw.Online === 'boolean') tailscale.online = raw.Online;
    if (typeof raw.Active === 'boolean') tailscale.reachable = raw.Active;
    if (lastSeen !== undefined) tailscale.lastSeen = lastSeen;
    const nodeId = nonBlank(raw.StableID) ?? nonBlank(raw.ID);
    if (nodeId !== undefined) tailscale.nodeId = nodeId;
    const computer: Computer = {
      id,
      machineName,
      displayName: extra.displayName?.trim() || machineName,
      // Keep the OS hostname as an alias so BOTH names resolve: the user may
      // say "laptop" (Tailscale) or "Guest" (what Windows calls itself).
      aliases: [
        ...new Set(
          [...(extra.aliases ?? []), osHostName ?? '']
            .map((alias) => alias.trim())
            .filter((alias) => alias !== '' && alias.toLocaleLowerCase() !== machineName.toLocaleLowerCase()),
        ),
      ],
      isSelf,
      tailscale,
      hasHumanMetadata: metadataKey !== undefined,
    };
    const role = extra.role?.trim();
    if (role) computer.role = role;
    const os = nonBlank(raw.OS);
    if (os !== undefined) computer.os = os;
    if (extra.capabilities !== undefined) computer.capabilities = extra.capabilities;
    if (extra.notes !== undefined && extra.notes.length > 0) computer.notes = [...extra.notes];
    return [computer];
  }).sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export class ComputerService {
  private cache: CacheEntry | undefined;
  private readonly cacheTtlMs: number;
  private readonly metadata: Record<string, ComputerMetadata>;

  constructor(private readonly tailscale: TailscaleClient, options: ComputerInventoryOptions = {}) {
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 10_000);
    this.metadata = options.metadata ?? {};
  }

  async list(forceRefresh = false): Promise<Computer[]> {
    if (!forceRefresh && this.cache !== undefined && this.cache.expiresAt > Date.now()) {
      return this.cache.computers.map((computer) => structuredClone(computer));
    }
    const inventory = normalizeTailscaleStatus(await this.tailscale.status(), this.metadata);
    this.cache = { computers: inventory, expiresAt: Date.now() + this.cacheTtlMs };
    return inventory.map((computer) => structuredClone(computer));
  }

  async get(idOrName: string): Promise<Computer> {
    const resolution = await this.resolve(idOrName);
    if (resolution.kind === 'match' && resolution.computer !== undefined) return resolution.computer;
    if (resolution.kind === 'ambiguous') {
      throw orchestratorError('COMPUTER_AMBIGUOUS', `More than one computer matches '${idOrName}'.`, {
        details: { candidates: resolution.candidates.map((computer) => ({ id: computer.id, name: computer.displayName })) },
      });
    }
    throw orchestratorError('COMPUTER_NOT_FOUND', `No known computer matches '${idOrName}'.`, {
      details: { query: idOrName },
    });
  }

  async resolve(query: string): Promise<ComputerResolution> {
    const normalizedQuery = normalizeLookup(query);
    if (!normalizedQuery) return { kind: 'not_found', candidates: [] };
    const inventory = await this.list();
    const scored = inventory.map((computer) => {
      const labels = [computer.id, computer.machineName, computer.displayName, computer.role ?? '', ...computer.aliases];
      const score = Math.max(...labels.map((label) => similarity(normalizedQuery, label)));
      return { computer, score, exact: labels.some((label) => normalizeLookup(label) === normalizedQuery) };
    }).sort((left, right) => right.score - left.score);
    const exact = scored.filter((candidate) => candidate.exact);
    if (exact.length === 1) return { kind: 'match', computer: exact[0]!.computer, candidates: [] };
    if (exact.length > 1) return { kind: 'ambiguous', candidates: exact.map((candidate) => candidate.computer) };
    const best = scored[0];
    const next = scored[1];
    if (best !== undefined && best.score >= 0.78 && (next === undefined || best.score - next.score >= 0.16)) {
      return { kind: 'match', computer: best.computer, candidates: [] };
    }
    const candidates = scored.filter((candidate) => candidate.score >= 0.55).slice(0, 5).map((candidate) => candidate.computer);
    return candidates.length > 0 ? { kind: 'ambiguous', candidates } : { kind: 'not_found', candidates: [] };
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
