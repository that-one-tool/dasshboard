/**
 * The window's one list of saved devices. Every view reads it and subscribes
 * to it instead of fetching on its own; it fetches only when asked to
 * `refresh` (after a device write, or a config reload). A failed fetch keeps
 * the last good list and is reported once.
 */

import { logToBackend, type AppError, type Device } from "../ipc";
import { isConnectionSettingsChanged, isJumpHopChanged } from "./connectionSettings";
import type { DevicesPort } from "./devicesPort";
import { getErrorMessage } from "../ui/errorMessage";

export interface DeviceChange {
  /** A copy of the list, not of its devices: treat those as read-only. */
  devices: Device[];
  /** Devices whose connection settings changed (`connectionSettings.ts`), or
   * what connecting through their jump host uses (one hop: no chains). */
  changedIds: string[];
}

export type DeviceChangeListener = (change: DeviceChange) => void;

export class DeviceCatalog {
  private devices: Device[] = [];
  private loaded = false;
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private readonly listeners = new Set<DeviceChangeListener>();

  constructor(
    private readonly port: DevicesPort,
    private readonly onError: (error: AppError) => void = () => {},
  ) {}

  /** A copy of the list, not of its devices: treat those as read-only. */
  list(): Device[] {
    return [...this.devices];
  }

  /** A shallow copy: its nested values are the catalog's own. */
  get(deviceId: string): Device | undefined {
    const device = this.devices.find((candidate) => candidate.id === deviceId);
    return device && { ...device };
  }

  /** Whether a fetch ever succeeded: until then the empty list is unknown,
   * not "no devices". */
  hasLoaded(): boolean {
    return this.loaded;
  }

  subscribe(listener: DeviceChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A call during a fetch waits for one more fetch after it (shared by every
   * such call): the running one may predate the write that asked. */
  refresh(): Promise<void> {
    // First: between the running fetch and the queued one, nothing runs, yet a
    // fetch started then would run beside the queued one.
    if (this.queued) return this.queued;
    if (!this.running) return this.start();
    // Caught: a load that rejects must not stay queued for good.
    this.queued = this.running.catch(() => {}).then(() => this.startQueued());
    return this.queued;
  }

  private startQueued(): Promise<void> {
    this.queued = null;
    return this.start();
  }

  private start(): Promise<void> {
    this.running = this.load().finally(() => (this.running = null));
    return this.running;
  }

  private async load(): Promise<void> {
    const devices = await this.fetchDevices();
    if (devices) this.apply(devices);
  }

  private async fetchDevices(): Promise<Device[] | null> {
    try {
      return await this.port.listDevices();
    } catch (error) {
      this.onError(error as AppError);
      return null;
    }
  }

  private apply(devices: Device[]): void {
    const change = diffDevices(this.devices, [...devices]);
    this.devices = devices;
    this.loaded = true;
    for (const listener of this.listeners) notify(listener, change);
  }
}

/** One failing view must not keep the change from the others. */
function notify(listener: DeviceChangeListener, change: DeviceChange): void {
  try {
    listener(change);
  } catch (error) {
    logToBackend("error", `device list listener failed: ${getErrorMessage(error)}`);
  }
}

function diffDevices(before: Device[], after: Device[]): DeviceChange {
  const afterById = new Map(after.map((device) => [device.id, device]));
  return {
    devices: after,
    changedIds: changedIdsOf(before, afterById),
  };
}

function changedIdsOf(before: Device[], afterById: Map<string, Device>): string[] {
  const edited = idsWhere(before, afterById, isConnectionSettingsChanged);
  const hops = idsWhere(before, afterById, isJumpHopChanged);
  const jumping = [...afterById.values()].filter((device) => jumpsThrough(device, hops)).map((device) => device.id);
  return [...new Set([...edited, ...jumping])];
}

/** The devices still there whose edit `isChanged` counts. */
function idsWhere(
  before: Device[],
  afterById: Map<string, Device>,
  isChanged: (before: Device, after: Device) => boolean,
): string[] {
  const changed = before.filter((device) => {
    const after = afterById.get(device.id);
    return after !== undefined && isChanged(device, after);
  });
  return changed.map((device) => device.id);
}

function jumpsThrough(device: Device, hopIds: string[]): boolean {
  return device.kind === "ssh" && device.proxyJump !== null && hopIds.includes(device.proxyJump);
}
