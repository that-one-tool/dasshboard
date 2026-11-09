/** The Files panel's connection state, shared by its parts: which device is
 * shown, which one the picker holds, and whether a connect is in flight. Read
 * freely; written only through the intention-named methods below. (Whether
 * work is in flight — `busy` — belongs to `PanelControls`, which keeps the
 * controls in step with it.) */
export class PanelSession {
  private active: string | null = null;
  private picked: string | null = null;
  private connectInFlight = false;
  private droppedWhenIdle = false;

  /** The device whose connection the panel shows (null when not connected). */
  get activeDeviceId(): string | null {
    return this.active;
  }

  /** The device chosen in the picker (may be selected but not yet connected, or
   * remembered across an idle/explicit disconnect for a one-click reconnect). */
  get selectedDeviceId(): string | null {
    return this.picked;
  }

  /** True while `sftpConnect` is in flight (the connect toggle is inert). */
  get connecting(): boolean {
    return this.connectInFlight;
  }

  /** True after an idle-timeout disconnect, so the disconnected state can say so. */
  get idleDisconnected(): boolean {
    return this.droppedWhenIdle;
  }

  isConnected(): boolean {
    return this.active !== null;
  }

  isConnectedTo(deviceId: string): boolean {
    return this.active === deviceId;
  }

  /** The connected device, else the one picked. */
  shownDeviceId(): string | null {
    return this.active ?? this.picked;
  }

  markConnected(deviceId: string): void {
    this.active = deviceId;
  }

  markDisconnected(): void {
    this.active = null;
  }

  pickDevice(deviceId: string | null): void {
    this.picked = deviceId;
  }

  startConnecting(): void {
    this.connectInFlight = true;
  }

  stopConnecting(): void {
    this.connectInFlight = false;
  }

  markIdleDisconnected(): void {
    this.droppedWhenIdle = true;
  }

  clearIdleDisconnected(): void {
    this.droppedWhenIdle = false;
  }
}
