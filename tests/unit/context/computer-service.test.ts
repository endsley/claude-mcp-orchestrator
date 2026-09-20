import { describe, expect, it } from 'vitest';
import { ComputerService, connectionType, normalizeTailscaleStatus } from '../../../src/services/tailscale/computer-service.js';
import { TailscaleClient, type TailscaleCommandRunner } from '../../../src/services/tailscale/tailscale-client.js';

class Runner implements TailscaleCommandRunner {
  constructor(private readonly output: string) {}
  async run(): Promise<string> { return this.output; }
}

describe('Tailscale computer normalization and resolution', () => {
  const raw = {
    Self: { ID: 'self-id', HostName: 'main-desktop', Online: true, Active: true, CurAddr: '100.1.2.3:41641', TailscaleIPs: ['100.1.2.3'] },
    Peer: {
      a: { ID: 'gpu-id', HostName: 'gpu-box', Online: true, Active: true, Relay: 'nyc', TailscaleIPs: ['100.1.2.4'] },
      b: { ID: 'old-id', HostName: 'old-laptop', Online: false, LastSeen: '2026-01-01T00:00:00Z' },
    },
  };

  it('does not infer direct connectivity from online alone', () => {
    expect(connectionType({ Online: true })).toBe('unknown');
    expect(connectionType({ Online: true, CurAddr: '100.1.2.3:41641' })).toBe('direct');
    expect(connectionType({ Online: true, Relay: 'nyc' })).toBe('relay');
    expect(connectionType({ Online: false })).toBe('idle');
  });

  it('merges human aliases while retaining stable machine identity', () => {
    const computers = normalizeTailscaleStatus(raw, { 'gpu-box': { displayName: 'GPU Server', aliases: ['AI machine', '24 GB machine'] } });
    const gpu = computers.find((computer) => computer.machineName === 'gpu-box')!;
    expect(gpu.id).toContain('gpu-id');
    expect(gpu.displayName).toBe('GPU Server');
    expect(gpu.aliases).toContain('AI machine');
    expect(gpu.tailscale.connectionType).toBe('relay');
    const self = computers.find((computer) => computer.machineName === 'main-desktop')!;
    expect(self.isSelf).toBe(true);
    expect(self.tailscale.connectionType).toBe('unknown');
  });

  it('resolves exact aliases and returns ambiguity instead of guessing', async () => {
    const client = new TailscaleClient(new Runner(JSON.stringify(raw)));
    const service = new ComputerService(client, { metadata: {
      'gpu-box': { aliases: ['AI machine', 'shared label'] },
      'old-laptop': { aliases: ['shared label'] },
    } });
    const alias = await service.resolve('ai MACHINE');
    expect(alias.kind).toBe('match');
    expect(alias.computer?.machineName).toBe('gpu-box');
    const ambiguous = await service.resolve('shared label');
    expect(ambiguous.kind).toBe('ambiguous');
    expect(ambiguous.candidates).toHaveLength(2);
  });
});
