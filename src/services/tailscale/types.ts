export type { Computer, ComputerMetadata, ConnectionType } from '../../types/computers.js';
import type { Computer } from '../../types/computers.js';

export interface TailscaleMachineRaw {
  ID?: string;
  StableID?: string;
  HostName?: string;
  DNSName?: string;
  OS?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  Active?: boolean;
  CurAddr?: string;
  Relay?: string;
  LastSeen?: string;
  ExitNode?: boolean;
}

export interface TailscaleStatusRaw {
  Self?: TailscaleMachineRaw;
  Peer?: TailscaleMachineRaw[] | Record<string, TailscaleMachineRaw>;
}

/** Compatibility helper for tool-level callers that do not need match scoring. */
export interface ComputerResolution {
  kind: 'match' | 'ambiguous' | 'not_found';
  computer?: Computer;
  candidates: Computer[];
}
