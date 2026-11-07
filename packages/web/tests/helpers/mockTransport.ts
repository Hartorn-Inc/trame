// Mocked network seam for ApiClient: scripted REST routes and controllable sockets.
import { encode } from "@msgpack/msgpack";
import type { SocketLike, Transport } from "../../src/api/client.ts";

/** Scripted REST reply keyed by `"METHOD /path"`. */
export interface RouteReply {
  status: number;
  body?: unknown;
}

/** Recorded REST call. */
export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
  credentials: RequestCredentials | undefined;
  headers: Record<string, string>;
}

/** Socket double: `open()` / `receive()` drive the client, `sent` records frames. */
export class MockSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: Uint8Array[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Server- or network-initiated close: handlers receive `{ code }` (1006 = refused handshake or drop). */
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Delivers raw bytes, or msgpack-encodes a plain value, as one frame. */
  receive(frame: Uint8Array | unknown): void {
    const bytes = frame instanceof Uint8Array ? frame : encode(frame);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.onmessage?.({ data: buffer });
  }
}

/** Transport double exposing recorded calls and opened sockets. */
export interface MockTransport extends Transport {
  calls: RecordedCall[];
  sockets: MockSocket[];
  routes: Record<string, RouteReply>;
}

/** Creates a transport answering from `routes`; unknown routes reply `404`. */
export function createMockTransport(routes: Record<string, RouteReply> = {}): MockTransport {
  const transport: MockTransport = {
    calls: [],
    sockets: [],
    routes,
    async fetch(url: string, init: RequestInit): Promise<Response> {
      const method = init.method ?? "GET";
      transport.calls.push({
        method,
        url,
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
        credentials: init.credentials,
        headers: (init.headers as Record<string, string>) ?? {},
      });
      const reply = transport.routes[`${method} ${url}`] ?? { status: 404, body: { error: "not found" } };
      return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status });
    },
    openSocket(url: string): SocketLike {
      const socket = new MockSocket(url);
      transport.sockets.push(socket);
      return socket;
    },
  };
  return transport;
}

/** `AuthUserDto` JSON as returned by `/api/v1/auth/*`. */
export function authUserDto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "gm@example.test",
    display_name: "Morgan",
    username: "Morgan",
    is_guest: false,
    is_ephemeral: false,
    role: "PLAYER",
    instance_role: "HOST",
    totp_enabled: false,
    ...overrides,
  };
}

/** `CampaignDto` JSON as returned by `/api/v1/campaigns`. */
export function campaignDto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Lost Mine",
    system: "dnd5e",
    role: "GM",
    created_at: "2026-11-01T10:00:00Z",
    actors: [],
    ...overrides,
  };
}

/** `ActorDto` JSON as returned by the actor routes. */
export function actorDto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    campaign_id: "22222222-2222-4222-8222-222222222222",
    owner_user_id: null,
    name: "Brakka",
    version: 1,
    data: {},
    ...overrides,
  };
}

/** Flushes pending promise callbacks and timers. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
