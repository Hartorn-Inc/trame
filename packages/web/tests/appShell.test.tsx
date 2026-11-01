import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { h, options, render } from "preact";
import { bootstrapSession, stripInviteParam } from "../src/api/bootstrap.ts";
import { ApiClient } from "../src/api/client.ts";
import { createSessionState } from "../src/api/session.ts";
import { localeSignal } from "../src/i18n/index.ts";
import { setupMockDom } from "./helpers/mockDom.ts";
import {
  authUserDto,
  campaignDto,
  createMockTransport,
  flush,
  type RouteReply,
} from "./helpers/mockTransport.ts";

localeSignal.value = "en";
options.debounceRendering = (cb: () => void) => cb();
// Preact defers `useEffect` to the next frame (100 ms fallback without rAF); run it on the next tick.
options.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
const doc = setupMockDom() as any;
(globalThis as any).innerWidth = 1280;
(globalThis as any).addEventListener = () => undefined;
(globalThis as any).removeEventListener = () => undefined;
const { App } = await import("../src/App.tsx");

const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const INVITE_REPLY: RouteReply = {
  status: 200,
  body: {
    user_id: "33333333-3333-4333-8333-333333333333",
    username: "Guest",
    campaign_id: CAMPAIGN_ID,
    character_id: null,
    role: "PLAYER",
    session_id: "44444444-4444-4444-8444-444444444444",
    user: authUserDto({ id: "33333333-3333-4333-8333-333333333333", is_guest: true, username: "Guest" }),
  },
};
const ME_OK: RouteReply = { status: 200, body: { user: authUserDto() } };
const ME_401: RouteReply = { status: 401, body: { code: "UNAUTHORIZED", error: "no session" } };
const INVITE_EXPIRED: RouteReply = { status: 401, body: { code: "EXPIRED_TOKEN", error: "invite token has expired" } };

function newClient(routes: Record<string, RouteReply>) {
  const transport = createMockTransport(routes);
  const state = createSessionState();
  const client = new ApiClient({ transport, state, wsOrigin: "ws://table.test" });
  return { client, state, transport };
}

const loc = (search: string) => ({ pathname: "/play", search, hash: "" });

describe("bootstrapSession: GuestSessionUpgrade before the auth guard", () => {
  const cases: Array<{
    id: string;
    search: string;
    routes: Record<string, RouteReply>;
    calls: string[];
    status: string;
    campaignId: string | null;
    replacedUrl: string | null;
    inviteError: string | null;
  }> = [
    {
      id: "valid invite redeems first, skips /auth/me and opens the invited campaign",
      search: `?invite=jwt-ok`,
      routes: { "POST /api/v1/auth/magic-link/redeem": INVITE_REPLY },
      calls: ["POST /api/v1/auth/magic-link/redeem"],
      status: "authenticated",
      campaignId: CAMPAIGN_ID,
      replacedUrl: "/play",
      inviteError: null,
    },
    {
      id: "expired invite falls back to the /auth/me restore and records the error",
      search: `?invite=jwt-old&lang=fr`,
      routes: { "POST /api/v1/auth/magic-link/redeem": INVITE_EXPIRED, "GET /api/v1/auth/me": ME_OK },
      calls: ["POST /api/v1/auth/magic-link/redeem", "GET /api/v1/auth/me"],
      status: "authenticated",
      campaignId: null,
      replacedUrl: "/play?lang=fr",
      inviteError: "EXPIRED_TOKEN",
    },
    {
      id: "no invite restores the session via /auth/me",
      search: "",
      routes: { "GET /api/v1/auth/me": ME_OK },
      calls: ["GET /api/v1/auth/me"],
      status: "authenticated",
      campaignId: null,
      replacedUrl: null,
      inviteError: null,
    },
    {
      id: "no invite and no session leaves the user anonymous",
      search: "",
      routes: { "GET /api/v1/auth/me": ME_401 },
      calls: ["GET /api/v1/auth/me"],
      status: "anonymous",
      campaignId: null,
      replacedUrl: null,
      inviteError: null,
    },
    {
      id: "identity query parameters are ignored (no user_id or role trust)",
      search: "?user_id=evil&role=GM&token=abc",
      routes: { "GET /api/v1/auth/me": ME_401 },
      calls: ["GET /api/v1/auth/me"],
      status: "anonymous",
      campaignId: null,
      replacedUrl: null,
      inviteError: null,
    },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      const { client, state, transport } = newClient(c.routes);
      let replaced: string | null = null;
      await bootstrapSession(client, loc(c.search), (url) => {
        replaced = url;
      });
      assert.deepEqual(transport.calls.map((call) => `${call.method} ${call.url}`), c.calls);
      assert.equal(state.status.value, c.status);
      assert.equal(state.activeCampaignId.value, c.campaignId);
      assert.equal(replaced, c.replacedUrl);
      assert.equal(state.inviteError.value, c.inviteError);
    });
  }

  it("stripInviteParam keeps unrelated parameters and the hash", () => {
    assert.equal(stripInviteParam({ pathname: "/", search: "?a=1&invite=x&b=2", hash: "#top" }), "/?a=1&b=2#top");
  });
});

describe("App shell rendered against a mocked transport", () => {
  let container: any = null;

  afterEach(() => {
    if (container) {
      render(null, container);
      doc.body.removeChild(container);
      container = null;
    }
  });

  async function mount(client: ApiClient, search = "") {
    container = doc.createElement("div");
    doc.body.appendChild(container);
    render(h(App, { client, location: loc(search), replaceUrl: () => undefined }), container);
    await flush(5);
    return container;
  }

  const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

  function typeInto(id: string, value: string) {
    const input = byTestId(id);
    input.value = value;
    input.dispatchEvent({ type: "input" });
  }

  const screenCases: Array<{ id: string; routes: Record<string, RouteReply>; search: string; visible: string; hidden: string }> = [
    {
      id: "anonymous visitor sees the sign-in screen",
      routes: { "GET /api/v1/auth/me": ME_401 },
      search: "",
      visible: "auth-screen",
      hidden: "campaign-lobby",
    },
    {
      id: "restored session lands on the campaign lobby",
      routes: { "GET /api/v1/auth/me": ME_OK, "GET /api/v1/campaigns": { status: 200, body: { campaigns: [] } } },
      search: "",
      visible: "campaign-lobby",
      hidden: "auth-screen",
    },
    {
      id: "failed invite shows the invite error on the sign-in screen",
      routes: { "POST /api/v1/auth/magic-link/redeem": INVITE_EXPIRED, "GET /api/v1/auth/me": ME_401 },
      search: "?invite=jwt-old",
      visible: "auth-invite-error",
      hidden: "campaign-lobby",
    },
  ];

  for (const c of screenCases) {
    it(c.id, async () => {
      const { client } = newClient(c.routes);
      await mount(client, c.search);
      assert.ok(byTestId(c.visible), `expected ${c.visible}`);
      assert.equal(byTestId(c.hidden), null);
    });
  }

  it("signing in from the auth screen loads the lobby campaigns", async () => {
    const { client, transport } = newClient({
      "GET /api/v1/auth/me": ME_401,
      "POST /api/v1/auth/login": { status: 200, body: { user: authUserDto() } },
      "GET /api/v1/campaigns": { status: 200, body: { campaigns: [campaignDto()] } },
    });
    await mount(client);
    typeInto("auth-email", "gm@example.test");
    typeInto("auth-password", "hunter2hunter2");
    byTestId("auth-form").dispatchEvent({ type: "submit" });
    await flush(5);

    const login = transport.calls.find((call) => call.url === "/api/v1/auth/login");
    assert.deepEqual(login?.body, { email: "gm@example.test", password: "hunter2hunter2" });
    assert.ok(byTestId(`lobby-campaign-${CAMPAIGN_ID}`));
  });

  it("wrong credentials show a localized alert and keep the form", async () => {
    const { client } = newClient({
      "GET /api/v1/auth/me": ME_401,
      "POST /api/v1/auth/login": { status: 401, body: { code: "INVALID_CREDENTIALS", error: "bad" } },
    });
    await mount(client);
    byTestId("auth-form").dispatchEvent({ type: "submit" });
    await flush(5);
    assert.equal(byTestId("auth-error").textContent, "Email or password is incorrect.");
    assert.equal(byTestId("auth-error").getAttribute("role"), "alert");
  });

  const inviteCases: Array<{ id: string; role: string; hasInvite: boolean }> = [
    { id: "GM campaign offers the invite button", role: "GM", hasInvite: true },
    { id: "player campaign hides the invite button", role: "PLAYER", hasInvite: false },
  ];

  for (const c of inviteCases) {
    it(c.id, async () => {
      const { client } = newClient({
        "GET /api/v1/auth/me": ME_OK,
        "GET /api/v1/campaigns": { status: 200, body: { campaigns: [campaignDto({ role: c.role })] } },
      });
      await mount(client);
      assert.equal(Boolean(byTestId(`lobby-invite-${CAMPAIGN_ID}`)), c.hasInvite);
    });
  }

  it("GM mints an invite through POST /campaigns/{id}/invites and sees the link", async () => {
    const { client, transport } = newClient({
      "GET /api/v1/auth/me": ME_OK,
      "GET /api/v1/campaigns": { status: 200, body: { campaigns: [campaignDto()] } },
      [`POST /api/v1/campaigns/${CAMPAIGN_ID}/invites`]: {
        status: 201,
        body: { invite_url: "https://trame.test/?invite=abc", token: "abc", expires_at: 1, campaign_id: CAMPAIGN_ID, role: "PLAYER" },
      },
    });
    await mount(client);
    byTestId(`lobby-invite-${CAMPAIGN_ID}`).dispatchEvent({ type: "click" });
    await flush(5);
    assert.ok(transport.calls.some((call) => call.method === "POST" && call.url.endsWith("/invites")));
    assert.equal(byTestId(`lobby-invite-url-${CAMPAIGN_ID}`).value, "https://trame.test/?invite=abc");
  });

  it("creating a campaign appends it to the lobby list", async () => {
    const { client, transport } = newClient({
      "GET /api/v1/auth/me": ME_OK,
      "GET /api/v1/campaigns": { status: 200, body: { campaigns: [] } },
      "POST /api/v1/campaigns": { status: 201, body: { campaign: campaignDto({ name: "Curse of Strahd" }) } },
    });
    await mount(client);
    typeInto("lobby-campaign-name", "  Curse of Strahd ");
    byTestId("lobby-create-form").dispatchEvent({ type: "submit" });
    await flush(5);
    assert.deepEqual(transport.calls.find((call) => call.method === "POST")?.body, { name: "Curse of Strahd" });
    assert.ok(byTestId(`lobby-campaign-${CAMPAIGN_ID}`));
  });

  it("invited player lands in the workspace with the room socket connected", async () => {
    const { client, state, transport } = newClient({
      "POST /api/v1/auth/magic-link/redeem": INVITE_REPLY,
      "GET /api/v1/campaigns": { status: 200, body: { campaigns: [campaignDto({ role: "PLAYER" })] } },
    });
    await mount(client, "?invite=jwt-ok");
    assert.ok(byTestId("trame-app-root"));
    assert.equal(transport.sockets.length, 1);
    assert.equal(transport.sockets[0].url, `ws://table.test/api/v1/campaigns/${CAMPAIGN_ID}/ws`);
    transport.sockets[0].open();
    await flush();
    assert.equal(byTestId("trame-status-badge").textContent, "Connected");

    byTestId("header-back-to-lobby").dispatchEvent({ type: "click" });
    await flush(5);
    assert.equal(transport.sockets[0].closed, true);
    assert.equal(state.activeCampaignId.value, null);
    assert.ok(byTestId("campaign-lobby"));
  });
});
