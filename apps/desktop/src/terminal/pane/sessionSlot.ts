/**
 * The backend session a terminal pane holds. DOM-free. A session is pending
 * from the moment its id is chosen: status events for it can arrive before
 * `connect()` returns, so the pane must recognize it already, and a pane that
 * let go of it meanwhile must not adopt it when `connect()` returns.
 */
export class SessionSlot {
  private currentId: string | null = null;
  private pendingId: string | null = null;
  private connected = false;

  get current(): string | null {
    return this.currentId;
  }

  open(sessionId: string): void {
    this.pendingId = sessionId;
  }

  isOwnerOf(sessionId: string): boolean {
    return sessionId === this.currentId || sessionId === this.pendingId;
  }

  isBusy(): boolean {
    return this.currentId !== null || this.pendingId !== null;
  }

  /** `connect()` returned: take the session, unless no longer pending. */
  adopt(sessionId: string): boolean {
    if (this.pendingId !== sessionId) return false;
    this.pendingId = null;
    this.currentId = sessionId;
    return true;
  }

  /** `connect()` failed: `true` when the failure is still this pane's to report. */
  failOpen(sessionId: string): boolean {
    if (this.pendingId !== sessionId) return false;
    this.pendingId = null;
    return true;
  }

  markConnected(): void {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.writableId() !== null;
  }

  /** The session that input goes to, if it is connected. */
  writableId(): string | null {
    return this.connected ? this.currentId : null;
  }

  /** The session to resize: `connected` can arrive before `connect()` returns. */
  resizableId(): string | null {
    return this.connected ? (this.currentId ?? this.pendingId) : null;
  }

  /** Let go of the open session only, keeping one still opening; returns the
   * id to close. */
  dropCurrent(): string | null {
    const sessionId = this.currentId;
    this.currentId = null;
    this.connected = false;
    return sessionId;
  }

  /** The session ended on its own. */
  end(): void {
    this.currentId = null;
    this.pendingId = null;
    this.connected = false;
  }

  /** Let go of the current and any opening session; returns their ids to close. */
  release(): string[] {
    const ids = [this.currentId, this.pendingId].filter((id) => id !== null);
    this.end();
    return ids;
  }
}
