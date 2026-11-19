/** An in-memory `TunnelsPort` for tests: logs each backend call, hands out
 * tunnel ids t1, t2, …, pushes status events, and can hold or fail a call. */

import type { AppError, Device, TunnelInfo, TunnelStatusEvent } from "../ipc";
import type { TunnelsPort } from "./tunnelsPort";

type ScriptedMethod =
  | "listDevices"
  | "listTunnels"
  | "startTunnel"
  | "stopTunnel"
  | "startTunnelForward"
  | "stopTunnelForward"
  | "onTunnelStatus";

export interface HeldCall {
  release(): void;
  fail(error: AppError): void;
}

export class FakeTunnelsPort implements TunnelsPort {
  devices: Device[] = [];
  tunnels: TunnelInfo[] = [];
  /** Backend calls in order: `start dev-1 t1 f1,f2`, `stop t1`, `bind t1 f2`,
   * `unbind t1 f2`. */
  readonly calls: string[] = [];
  private statusHandler: ((event: TunnelStatusEvent) => void) | null = null;
  private readonly scripted = new Map<ScriptedMethod, Array<() => Promise<void>>>();
  private idCount = 0;

  /** The next call of `method` waits until it is released or failed. */
  hold(method: ScriptedMethod): HeldCall {
    const held: HeldCall = { release: () => {}, fail: () => {} };
    const gate = new Promise<void>((resolve, reject) => {
      held.release = resolve;
      held.fail = reject;
    });
    this.script(method, () => gate);
    return held;
  }

  /** The next call of `method` rejects with `error`. */
  failNext(method: ScriptedMethod, error: AppError): void {
    this.script(method, () => Promise.reject(error));
  }

  /** The backend sends a `tunnel_status` event. */
  emit(event: TunnelStatusEvent): void {
    this.statusHandler?.(event);
  }

  get isSubscribed(): boolean {
    return this.statusHandler !== null;
  }

  lastTunnelId(): string {
    return `t${this.idCount}`;
  }

  newTunnelId(): string {
    this.idCount += 1;
    return this.lastTunnelId();
  }

  async listDevices(): Promise<Device[]> {
    await this.run("listDevices");
    return this.devices;
  }

  async listTunnels(): Promise<TunnelInfo[]> {
    await this.run("listTunnels");
    return this.tunnels;
  }

  async startTunnel(deviceId: string, tunnelId: string, forwardIds: string[]): Promise<string> {
    this.calls.push(`start ${deviceId} ${tunnelId} ${forwardIds.join(",")}`);
    await this.run("startTunnel");
    return tunnelId;
  }

  async stopTunnel(tunnelId: string): Promise<void> {
    this.calls.push(`stop ${tunnelId}`);
    await this.run("stopTunnel");
  }

  async startTunnelForward(tunnelId: string, forwardId: string): Promise<void> {
    this.calls.push(`bind ${tunnelId} ${forwardId}`);
    await this.run("startTunnelForward");
  }

  async stopTunnelForward(tunnelId: string, forwardId: string): Promise<void> {
    this.calls.push(`unbind ${tunnelId} ${forwardId}`);
    await this.run("stopTunnelForward");
  }

  async onTunnelStatus(handler: (event: TunnelStatusEvent) => void): Promise<() => void> {
    await this.run("onTunnelStatus");
    this.statusHandler = handler;
    return () => {
      this.statusHandler = null;
    };
  }

  private script(method: ScriptedMethod, step: () => Promise<void>): void {
    const steps = this.scripted.get(method) ?? [];
    steps.push(step);
    this.scripted.set(method, steps);
  }

  private run(method: ScriptedMethod): Promise<void> {
    const step = this.scripted.get(method)?.shift();
    return step ? step() : Promise.resolve();
  }
}
