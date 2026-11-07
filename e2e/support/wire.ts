/**
 * ============================================================================
 * ROOM SOCKET FRAME RECORDER (wire.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Records every MessagePack frame a page receives on the campaign room socket
 * and decodes it the way the web client does, so the suite can assert what
 * the server actually SENT to a recipient (player projection), not just what
 * the UI chose to render. It also lists the commands a page sent, so a test
 * can prove a duplicate command reached the server.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Client-Parity Decoding`:
 *    - 16-byte binary values and map keys become hyphenated UUID strings,
 *      mirroring `packages/web/src/api/wire.ts`, so ids compare as strings.
 * 2. `Externally Tagged Envelopes`:
 *    - Each frame is `{ Tag: payload }`; `tag` / `payload` keep that split and
 *      undecodable frames are kept with `tag = "UNDECODABLE"`.
 * ============================================================================
 */
import { Decoder } from '@msgpack/msgpack';
import type { Page } from '@playwright/test';

/** One decoded server frame. */
export interface RecordedFrame {
  /** Envelope tag, e.g. `StateSnapshot`, `CommandAccepted`, `DiceRolled`. */
  tag: string;
  /** Envelope payload with UUIDs normalized to strings. */
  payload: Record<string, unknown>;
}

function uuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return value.length === 16 ? uuid(value) : value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

const decoder = new Decoder({
  mapKeyConverter: (key: unknown): string | number => {
    if (key instanceof Uint8Array && key.length === 16) return uuid(key);
    if (typeof key === 'string' || typeof key === 'number') return key;
    return String(key);
  },
});

/** Attaches a recorder to every room socket `page` opens; returns the live frame list. */
export function recordRoomFrames(page: Page): RecordedFrame[] {
  const frames: RecordedFrame[] = [];
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/campaigns/')) return;
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') return;
      try {
        const raw = normalize(decoder.decode(payload)) as Record<string, unknown>;
        const [tag] = Object.keys(raw);
        frames.push({ tag, payload: (raw[tag] ?? {}) as Record<string, unknown> });
      } catch {
        frames.push({ tag: 'UNDECODABLE', payload: {} });
      }
    });
  });
  return frames;
}

/**
 * Records the `cmd` of every `SubmitCommand` frame `page` sends on a room
 * socket, so a test can prove a command really reached the server twice.
 */
export function recordSentCommands(page: Page): string[] {
  const sent: string[] = [];
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/campaigns/')) return;
    ws.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') return;
      try {
        const raw = normalize(decoder.decode(payload)) as { SubmitCommand?: { cmd?: unknown } };
        if (raw.SubmitCommand) sent.push(String(raw.SubmitCommand.cmd));
      } catch {
        sent.push('UNDECODABLE');
      }
    });
  });
  return sent;
}

/** Projected table state carried by `StateSnapshot` / `CommandAccepted` frames. */
export interface ProjectedState {
  tokens: Record<string, Record<string, unknown>>;
  public_tokens?: Record<string, Record<string, unknown>>;
  walls: Array<Record<string, unknown>>;
  [field: string]: unknown;
}

/** Every projected table state in arrival order. */
export function states(frames: RecordedFrame[]): ProjectedState[] {
  return frames
    .filter((f) => f.tag === 'StateSnapshot' || f.tag === 'CommandAccepted')
    .map((f) => f.payload.state as ProjectedState)
    .filter(Boolean);
}

/** Most recent projected table state, or `null` before the first snapshot. */
export function latestState(frames: RecordedFrame[]): ProjectedState | null {
  const all = states(frames);
  return all.length > 0 ? all[all.length - 1] : null;
}
