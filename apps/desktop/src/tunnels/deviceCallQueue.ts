/** Backend calls per device, one at a time: a tunnel's forward adds/removes
 * are deltas, so they must reach it in click order. Callers catch their own
 * errors; a rejected call would stall the device's later ones. */
export class DeviceCallQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs `call` after the device's earlier calls; resolves when it is done. */
  enqueue(deviceId: string, call: () => Promise<void>): Promise<void> {
    const next = (this.tails.get(deviceId) ?? Promise.resolve()).then(call);
    this.tails.set(deviceId, next);
    return next;
  }
}
