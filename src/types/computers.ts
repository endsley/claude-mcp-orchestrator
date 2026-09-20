/**
 * How a peer is currently reached. Deliberately distinct from `online`: a
 * machine can be online and reachable only through a DERP relay, and calling
 * that "directly connected" would be a lie the voice layer would repeat.
 */
export type ConnectionType = 'direct' | 'relay' | 'peer-relay' | 'idle' | 'unknown';

export interface ComputerCapabilities {
  cpu?: string;
  ramGb?: number;
  gpu?: string;
  vramGb?: number;
  services?: string[];
}

export interface ComputerTailscaleState {
  dnsName?: string;
  ipv4?: string;
  ipv6?: string;
  /** Tailscale's own notion of the peer being up. `undefined` when unknown. */
  online?: boolean;
  /** Whether *this* machine currently has a working path to the peer. */
  reachable?: boolean;
  connectionType: ConnectionType;
  /** ISO timestamp. Absent when Tailscale did not report one. */
  lastSeen?: string;
  /** Tailscale's stable node ID, when exposed. */
  nodeId?: string;
}

export interface Computer {
  /**
   * Stable identity, independent of display name. Derived from the Tailscale
   * node ID when available so that renaming a machine in the admin console does
   * not orphan sessions or config that reference it.
   */
  id: string;
  machineName: string;
  displayName: string;
  aliases: string[];
  role?: string;
  os?: string;
  /** True for the machine the orchestrator itself runs on. */
  isSelf: boolean;
  tailscale: ComputerTailscaleState;
  capabilities?: ComputerCapabilities;
  notes?: string[];
  /** True when the operator has supplied human metadata for this machine. */
  hasHumanMetadata: boolean;
}

/** Operator-authored metadata merged on top of live Tailscale data. */
export interface ComputerMetadata {
  displayName?: string;
  role?: string;
  aliases?: string[];
  notes?: string[];
  capabilities?: ComputerCapabilities;
}

export interface ComputerInventory {
  computers: Computer[];
  /** The machine this orchestrator runs on, if it could be identified. */
  self?: Computer;
  /** ISO timestamp of the underlying Tailscale query. */
  fetchedAt: string;
  /** True when served from cache rather than a fresh `tailscale status` call. */
  cached: boolean;
  /** Non-fatal problems, e.g. "tailscale reported a peer with no hostname". */
  warnings: string[];
}
