// Connected ApiClient fixture for live-table component tests: projected snapshots in, decoded frames out.
import { decode } from "@msgpack/msgpack";
import { options, render, type VNode } from "preact";
import { ApiClient } from "../../src/api/client.ts";
import { createSessionState } from "../../src/api/session.ts";
import type { ProjectedTableState, WireTokenState } from "../../src/api/wire.ts";
import { createMockTransport, type MockSocket, type MockTransport, type RouteReply } from "./mockTransport.ts";

export const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
export const GM_ID = "11111111-1111-4111-8111-111111111111";
export const PLAYER_ID = "44444444-4444-4444-8444-444444444444";
export const OTHER_PLAYER_ID = "55555555-5555-4555-8555-555555555555";
export const HERO = "aaaaaaaa-0000-4000-8000-000000000001";
export const GOBLIN = "aaaaaaaa-0000-4000-8000-000000000002";
export const HERO_ACTOR = "33333333-3333-4333-8333-333333333333";

/** Full `TokenState`-like token for `tokens`. */
export function fullToken(id: string, name: string, overrides: Partial<WireTokenState> = {}): WireTokenState {
  return { id, name, owner_user_id: null, actor_id: null, top_left: { x: 0, y: 0 }, grid_w: 1, grid_h: 1, hp: 10, max_hp: 10, temp_hp: 0, conditions: [], ...overrides };
}

/** Reduced `PublicTokenView` for `public_tokens`. */
export function publicToken(id: string, name: string, overrides: Partial<WireTokenState> = {}): WireTokenState {
  return { id, name, top_left: { x: 0, y: 0 }, grid_w: 1, grid_h: 1, bloodied: "UNHURT", conditions: [], ...overrides };
}

/** Projected table with sensible defaults (50 px cells, 1000 px square map). */
export function tableState(overrides: Partial<ProjectedTableState> = {}): ProjectedTableState {
  return {
    campaign_id: CAMPAIGN,
    mode: "EXPLORATION",
    exploration_paused: false,
    ambient_lighting: "DAYLIGHT",
    cell_size_px: 50,
    feet_per_cell: 5,
    tokens: {},
    public_tokens: {},
    walls: [],
    persistent_aoes: {},
    initiative_order: [],
    active_turn_index: null,
    round: 1,
    lights: [],
    fog_overrides: [],
    background_asset_hash: null,
    map_width_px: 1000,
    map_height_px: 1000,
    active_reaction_prompts: {},
    mcp_staging_proposals: {},
    ...overrides,
  };
}

export interface LiveTable {
  client: ApiClient;
  transport: MockTransport;
  socket: MockSocket;
  /** Decoded outbound envelopes (`{ SubmitCommand: {...} }`, `{ RollDice: {...} }`, ...). */
  frames(): Record<string, any>[];
  /** Inner command maps of every `SubmitCommand` frame. */
  commands(): Record<string, any>[];
  snapshot(state: ProjectedTableState): void;
}

/** Signed-in client with an open room socket and an applied snapshot. */
export function liveTable(userId: string, state: ProjectedTableState | null, routes: Record<string, RouteReply> = {}): LiveTable {
  const transport = createMockTransport(routes);
  const client = new ApiClient({ transport, state: createSessionState() });
  client.state.user.value = { id: userId, email: "", displayName: "User", username: "user", isGuest: false, role: "PLAYER" };
  client.state.status.value = "authenticated";
  client.connect(CAMPAIGN);
  const socket = transport.sockets[0];
  socket.open();
  let seq = 0;
  const snapshot = (s: ProjectedTableState) => client.applyServerEnvelope({ type: "StateSnapshot", seqId: seq++, state: s });
  if (state) snapshot(state);
  const frames = () => socket.sent.map((bytes) => decode(bytes) as Record<string, any>);
  return {
    client,
    transport,
    socket,
    frames,
    commands: () => frames().filter((f) => f.SubmitCommand).map((f) => f.SubmitCommand),
    snapshot,
  };
}

/** Mounts a vnode with synchronous re-rendering; returns query helpers. */
export function mount(vnode: VNode<any>) {
  options.debounceRendering = (cb: () => void) => cb();
  const doc = (globalThis as any).document;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  render(vnode, container);
  const byTestId = (id: string): any => container.querySelector(`[data-testid="${id}"]`);
  return {
    container,
    byTestId,
    click(id: string, extra: Record<string, unknown> = {}) {
      const el = byTestId(id);
      if (!el) throw new Error(`missing ${id}`);
      el.dispatchEvent({ type: "click", ...extra });
    },
    key(id: string, key: string) {
      const el = byTestId(id);
      if (!el) throw new Error(`missing ${id}`);
      el.dispatchEvent({ type: "keydown", key });
    },
    input(id: string, value: string, type = "input") {
      const el = byTestId(id);
      if (!el) throw new Error(`missing ${id}`);
      el.value = value;
      el.dispatchEvent({ type });
    },
    unmount: () => render(null, container),
  };
}
