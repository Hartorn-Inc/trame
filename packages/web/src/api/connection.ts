/**
 * ============================================================================
 * CAMPAIGN ROOM CONNECTION MANAGER (api/connection.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Keeps one live WebSocket to the campaign room for as long as a campaign is
 * open. Without it a network drop, a server restart, or a deploy (close
 * `1001 Going Away`) leaves the player on a frozen table until they reload,
 * and a half-open TCP connection (laptop sleep, NAT timeout) looks "open"
 * while no frame ever arrives (audit RT11 / UA16).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Exponential Backoff With Jitter`:
 *    - Retry `n` (1-based) waits `min(15 s, 0.5 s * 2^(n-1))`, scaled by a
 *      random factor in `[0.8, 1.2]` and capped again at 15 s, so a server
 *      restart is not hit by every client at the same instant.
 *    - The attempt counter resets only when the client reports a healthy
 *      room (`markHealthy`, called on `StateSnapshot`), so a server that
 *      accepts and immediately drops the socket still backs off.
 * 2. `Fail-Closed Access Errors (No Reconnect Loop)`:
 *    - The server rejects missing credentials (`401`) and non-members
 *      (`403`) before the upgrade; browsers only report such a failed
 *      handshake as close `1006` without `onopen`. A socket that closes
 *      before opening therefore triggers one REST access probe: `401` stops
 *      in `signedOut`, `403` stops in `forbidden`, anything else retries.
 *    - Close codes `4401` (`signedOut`), `1008` and `4403` (`forbidden`)
 *      stop immediately, for servers that report access loss in-band
 *      (`4403`: membership revoked after the socket attached).
 *    - Close code `1011` (the room actor timed out or stopped) is a server
 *      fault, never an access decision: it always retries with backoff and
 *      skips the access probe, so the next attempt wakes a fresh room.
 * 3. `Heartbeat`:
 *    - Every 20 s an open socket sends `Ping`; no `Pong` within 10 s marks
 *      the socket dead, detaches it, and schedules a reconnect without
 *      waiting for the browser's own (possibly minutes-long) close.
 * 4. `Browser Network Hints`:
 *    - `offline` drops the socket and pauses retries (`offline` status);
 *      `online` and the page becoming visible retry immediately; a visible
 *      page with an open socket sends a heartbeat at once to detect sockets
 *      that died while the tab slept.
 * 5. `Stale Socket Isolation`:
 *    - Handlers are detached before any socket is closed and every callback
 *      checks it still belongs to the current socket, so an old socket can
 *      never flip the status or deliver frames after a reconnect.
 * 6. `Loss Is Reported Once`:
 *    - `onSocketLost` runs once per opened socket that dies unexpectedly
 *      (close, missing `Pong`, browser offline), before it is detached, so
 *      the client can report actions that may not have been applied. A
 *      deliberate `stop()` or `start()` never reports a loss.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `start(url)` -> status `connecting` -> `openSocket()`
 * ├── `onopen`  -> status `open`, heartbeat starts, `onOpen()` (resync prep).
 * ├── `onclose` -> 4401 / 1008 / 4403: terminal status.
 * │             -> 1011: `scheduleRetry()` without probing.
 * │             -> never opened: `probeAccess()` -> terminal or retry.
 * │             -> otherwise: `scheduleRetry()` (status `reconnecting`).
 * ├── no `Pong` -> detach socket -> `scheduleRetry()`.
 * └── `stop()`  -> detach socket, clear timers, status `closed`.
 * ============================================================================
 */
import type { ConnectionStatus, ReconnectInfo, SessionState } from "./session.ts";

/** `WebSocket.OPEN` without depending on a global `WebSocket` in tests. */
export const SOCKET_OPEN = 1;

/** RFC 6455 `Going Away`: server shutdown, hibernation, or deploy. Reconnects. */
export const CLOSE_GOING_AWAY = 1001;
/** RFC 6455 `Policy Violation`: the server refuses this client. Terminal (`forbidden`). */
export const CLOSE_POLICY_VIOLATION = 1008;
/** RFC 6455 `Internal Error`: the room actor timed out or stopped. Reconnects (invariant 2). */
export const CLOSE_INTERNAL_ERROR = 1011;
/** Application code: the session is no longer authenticated. Terminal (`signedOut`). */
export const CLOSE_UNAUTHORIZED = 4401;
/** Application code: the user lost access to the campaign. Terminal (`forbidden`). */
export const CLOSE_FORBIDDEN = 4403;
/** Code browsers report for a dropped connection or a refused handshake. */
const CLOSE_ABNORMAL = 1006;

/** First retry delay in milliseconds (`ms`). */
export const RECONNECT_BASE_DELAY_MS = 500;
/** Upper bound of any retry delay in milliseconds (`ms`). */
export const RECONNECT_MAX_DELAY_MS = 15_000;
/** Relative jitter applied to each delay (`0.2` = +/-20 %). */
export const RECONNECT_JITTER_RATIO = 0.2;
/** Interval between heartbeat `Ping`s on an open socket, in milliseconds (`ms`). */
export const HEARTBEAT_INTERVAL_MS = 20_000;
/** Time a heartbeat `Ping` may wait for its `Pong` before the socket is dead, in milliseconds (`ms`). */
export const PONG_TIMEOUT_MS = 10_000;

/** Minimal socket surface used by the client (satisfied by `WebSocket`). */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Outcome of the REST access probe run after a refused handshake. */
export type AccessProbeResult =
  /** Credentials and membership are valid; the failure was transient. Retry. */
  | "ok"
  /** `401`: the session expired. Stop in `signedOut`. */
  | "signedOut"
  /** `403`: the user is not (or no longer) a member. Stop in `forbidden`. */
  | "forbidden"
  /** Network error or any other status. Retry. */
  | "unreachable";

/** Browser connectivity hints (`navigator.onLine`, `online`/`offline`, page visibility). */
export interface NetworkWatcher {
  /** `false` only when the browser is certain there is no network. */
  isOnline(): boolean;
  /** Subscribes to connectivity hints; returns the unsubscribe function. */
  watch(handlers: { online(): void; offline(): void; visible(): void }): () => void;
}

/** Inputs of `ConnectionManager`. */
export interface ConnectionManagerOptions {
  /** Signals the manager writes (`connection`, `reconnect`). */
  state: Pick<SessionState, "connection" | "reconnect">;
  /** Opens a socket to `url` (the transport seam). */
  openSocket(url: string): SocketLike;
  /** Receives every inbound frame of the current socket. */
  onFrame(data: unknown): void;
  /** Runs when a new socket opens, before any of its frames (resync preparation). */
  onOpen(): void;
  /** Runs once when an opened socket dies unexpectedly (invariant 6). */
  onSocketLost?(): void;
  /** Classifies a refused handshake through REST (see invariant 2). */
  probeAccess(): Promise<AccessProbeResult>;
  /** Encodes a heartbeat `Ping` carrying `nowMs`. */
  encodePing(nowMs: number): Uint8Array;
  /** Connectivity hints; defaults to the browser's. */
  network?: NetworkWatcher;
  /** Uniform random source in `[0, 1)` for jitter; defaults to `Math.random`. */
  random?: () => number;
}

/** Timer handle as returned by `setTimeout` / `setInterval` in browsers and Node. */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Timers must not keep a non-browser runtime (node:test, SSR) alive on their
 * own: a forgotten open socket would otherwise hang the test process.
 */
function unref(handle: TimerHandle): TimerHandle {
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

/**
 * Delay before retry `attempt` (1-based) in milliseconds (`ms`):
 * `min(MAX, min(MAX, BASE * 2^(attempt-1)) * (1 - J + 2 * J * random))`.
 */
export function reconnectDelayMs(attempt: number, random: number): number {
  const base = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 - RECONNECT_JITTER_RATIO + 2 * RECONNECT_JITTER_RATIO * random;
  return Math.round(Math.min(RECONNECT_MAX_DELAY_MS, base * jitter));
}

/** Connectivity hints from `window`, `document`, and `navigator`; inert outside a browser. */
export function browserNetworkWatcher(): NetworkWatcher {
  return {
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
    watch(handlers) {
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => undefined;
      const onVisibility = () => {
        if (document.visibilityState !== "hidden") handlers.visible();
      };
      window.addEventListener("online", handlers.online);
      window.addEventListener("offline", handlers.offline);
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        window.removeEventListener("online", handlers.online);
        window.removeEventListener("offline", handlers.offline);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
  };
}

const TERMINAL: ReadonlySet<ConnectionStatus> = new Set(["signedOut", "forbidden", "closed", "idle"]);

/** Reconnecting WebSocket owner for one campaign room at a time. */
export class ConnectionManager {
  private readonly options: ConnectionManagerOptions;
  private readonly network: NetworkWatcher;
  private readonly random: () => number;
  private url: string | null = null;
  private socket: SocketLike | null = null;
  private opened = false;
  /** Failed attempts since the last healthy room; drives the backoff. */
  private attempt = 0;
  /** Bumped on every open/stop so a late access probe cannot act on a newer socket. */
  private generation = 0;
  private retryTimer: TimerHandle | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: TimerHandle | null = null;
  private unwatch: (() => void) | null = null;

  constructor(options: ConnectionManagerOptions) {
    this.options = options;
    this.network = options.network ?? browserNetworkWatcher();
    this.random = options.random ?? Math.random;
  }

  private get status(): ConnectionStatus {
    return this.options.state.connection.value;
  }

  private setStatus(status: ConnectionStatus, nextRetryAtMs: number | null = null): void {
    this.options.state.connection.value = status;
    this.options.state.reconnect.value = { attempt: this.attempt, nextRetryAtMs } satisfies ReconnectInfo;
  }

  /** Connects to `url`, replacing any previous room connection. */
  start(url: string): void {
    this.stop();
    this.url = url;
    this.attempt = 0;
    this.unwatch = this.network.watch({
      online: () => this.onOnline(),
      offline: () => this.onOffline(),
      visible: () => this.onVisible(),
    });
    this.setStatus("connecting");
    this.open();
  }

  /** Closes the room connection for good (leaving the campaign, signing out). */
  stop(): void {
    const hadRoom = this.url !== null;
    this.url = null;
    this.generation += 1;
    this.unwatch?.();
    this.unwatch = null;
    this.clearRetry();
    this.dropSocket();
    if (hadRoom) this.setStatus("closed");
  }

  /** Called once the room proved healthy (a `StateSnapshot` arrived): resets the backoff. */
  markHealthy(): void {
    this.attempt = 0;
    if (this.status === "open") this.setStatus("open");
  }

  /** Called for every `Pong`: the socket is alive. */
  notePong(): void {
    if (this.pongTimer !== null) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  /** Sends one binary frame; `false` unless the current socket is open. */
  send(bytes: Uint8Array): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    this.socket.send(bytes);
    return true;
  }

  /** Skips the remaining backoff delay (banner "Reconnect now", `online`, visible page). */
  reconnectNow(): void {
    if (this.url === null || this.socket || TERMINAL.has(this.status)) return;
    this.clearRetry();
    this.open();
  }

  private open(): void {
    const url = this.url;
    if (url === null) return;
    if (!this.network.isOnline()) {
      this.goOffline();
      return;
    }
    this.generation += 1;
    this.opened = false;
    if (this.status === "reconnecting" || this.status === "offline") this.setStatus("reconnecting");
    const socket = this.options.openSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.opened = true;
      this.setStatus("open");
      this.startHeartbeat();
      this.options.onOpen();
    };
    socket.onclose = (ev) => {
      if (this.socket === socket) this.handleClose((ev as { code?: number } | null)?.code ?? CLOSE_ABNORMAL);
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.options.onFrame(ev.data);
    };
    this.socket = socket;
  }

  private handleClose(code: number): void {
    const wasOpened = this.opened;
    this.loseSocket();
    if (code === CLOSE_UNAUTHORIZED) {
      this.setStatus("signedOut");
    } else if (code === CLOSE_POLICY_VIOLATION || code === CLOSE_FORBIDDEN) {
      this.setStatus("forbidden");
    } else if (code === CLOSE_INTERNAL_ERROR) {
      this.scheduleRetry();
    } else if (!wasOpened) {
      void this.probeThenRetry();
    } else {
      this.scheduleRetry();
    }
  }

  private async probeThenRetry(): Promise<void> {
    const generation = this.generation;
    const result = await this.options.probeAccess().catch((): AccessProbeResult => "unreachable");
    if (generation !== this.generation || this.url === null) return;
    if (result === "signedOut" || result === "forbidden") this.setStatus(result);
    else this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.url === null) return;
    if (!this.network.isOnline()) {
      this.goOffline();
      return;
    }
    this.clearRetry();
    this.attempt += 1;
    const delay = reconnectDelayMs(this.attempt, this.random());
    this.setStatus("reconnecting", Date.now() + delay);
    this.retryTimer = unref(
      setTimeout(() => {
        this.retryTimer = null;
        this.open();
      }, delay),
    );
  }

  private goOffline(): void {
    this.clearRetry();
    this.loseSocket();
    this.setStatus("offline");
  }

  private onOnline(): void {
    if (this.status === "offline" || this.status === "reconnecting") this.reconnectNow();
  }

  private onOffline(): void {
    if (this.url !== null && !TERMINAL.has(this.status)) this.goOffline();
  }

  private onVisible(): void {
    if (this.status === "open") this.sendHeartbeat();
    else if (this.status === "reconnecting" || this.status === "offline") this.reconnectNow();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = unref(setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS));
  }

  private sendHeartbeat(): void {
    if (this.pongTimer !== null) return;
    if (!this.send(this.options.encodePing(Date.now()))) return;
    this.pongTimer = unref(
      setTimeout(() => {
        this.pongTimer = null;
        this.loseSocket();
        this.scheduleRetry();
      }, PONG_TIMEOUT_MS),
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.notePong();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Reports an unexpected loss of an opened socket (invariant 6), then drops it. */
  private loseSocket(): void {
    if (this.socket && this.opened) this.options.onSocketLost?.();
    this.dropSocket();
  }

  /** Detaches every handler, then closes the socket (invariant 5). */
  private dropSocket(): void {
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    this.opened = false;
    if (!socket) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onmessage = null;
    socket.close();
  }
}
