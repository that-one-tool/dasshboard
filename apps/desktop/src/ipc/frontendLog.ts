import { logFrontend, type LogLevel } from "./logs";

/** A repeated problem (a slow call on every keystroke) is logged at most once
 * per interval, so it can't flood the log or the IPC it is about. */
const MIN_INTERVAL_MS = 10_000;

type Sink = (level: LogLevel, message: string) => void;

/** Fire and forget: logging must never fail its caller. */
export function logToBackend(level: LogLevel, message: string): void {
  logFrontend(level, message).catch(() => {});
}

interface KindState {
  sentAt: number;
  dropped: number;
}

/**
 * Logs one line per `kind` per interval; the next line of a kind counts those
 * dropped since its last one. A kind quiet for an interval with nothing dropped
 * is forgotten, so per-device kinds don't pile up.
 */
export class ThrottledLog {
  private readonly kinds = new Map<string, KindState>();

  constructor(
    private readonly sink: Sink,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = MIN_INTERVAL_MS,
  ) {}

  get trackedKinds(): number {
    return this.kinds.size;
  }

  log(level: LogLevel, kind: string, message: string): void {
    this.forgetQuietKinds();
    const recent = this.recentState(kind);
    if (recent) {
      recent.dropped += 1;
      return;
    }
    const dropped = this.kinds.get(kind)?.dropped;
    this.kinds.set(kind, { sentAt: this.now(), dropped: 0 });
    this.sink(level, withDropped(message, dropped));
  }

  private recentState(kind: string): KindState | undefined {
    const state = this.kinds.get(kind);
    return state !== undefined && this.isRecent(state) ? state : undefined;
  }

  private isRecent(state: KindState): boolean {
    return this.now() - state.sentAt < this.intervalMs;
  }

  private forgetQuietKinds(): void {
    for (const [kind, state] of this.kinds) {
      if (this.isForgettable(state)) this.kinds.delete(kind);
    }
  }

  private isForgettable(state: KindState): boolean {
    return state.dropped === 0 && !this.isRecent(state);
  }
}

function withDropped(message: string, dropped = 0): string {
  return dropped === 0 ? message : `${message} (${dropped} similar dropped)`;
}

const throttled = new ThrottledLog(logToBackend);

/** A console warning, also in the diagnostic log (throttled per `kind`). */
export function warnThrottled(kind: string, message: string): void {
  console.warn(message);
  throttled.log("warn", kind, message);
}
