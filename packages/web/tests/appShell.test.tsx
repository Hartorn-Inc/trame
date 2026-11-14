import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { h, options, render } from "preact";
import { bootstrapSession, readBootRoute, stripBootSecrets } from "../src/api/bootstrap.ts";
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
import { assertAbsent } from "./helpers/domAssert.ts";

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
const PLAYER_ID = "33333333-3333-4333-8333-333333333333";
const ME_OK: RouteReply = { status: 200, body: { user: authUserDto() } };
const ME_401: RouteReply = { status: 401, body: { code: "UNAUTHORIZED", error: "no session" } };
const REGISTRATION_OPEN: RouteReply = { status: 200, body: { registration_open: true, owner_claimed: true } };
const REGISTRATION_CLOSED: RouteReply = { status: 200, body: { registration_open: false, owner_claimed: true } };
const PREVIEW_ACTIVE: RouteReply = {
  status: 200,
  body: { campaign_id: CAMPAIGN_ID, campaign_name: "Lost Mine", status: "active", expires_at: 1_900_000_000 },
};
const REDEEM_CREATED: RouteReply = {
  status: 201,
  body: {
    campaign_id: CAMPAIGN_ID,
    role: "PLAYER",
    already_member: false,
    account_created: true,
    user: authUserDto({ id: PLAYER_ID, email: "pc@example.test", display_name: "Lyra", username: "Lyra", instance_role: "MEMBER" }),
  },
};

function newClient(routes: Record<string, RouteReply>) {
  const transport = createMockTransport(routes);
  const state = createSessionState();
  const client = new ApiClient({ transport, state, wsOrigin: "ws://table.test" });
  return { client, state, transport };
}

const loc = (search: string) => ({ pathname: "/play", search, hash: "" });

describe("bootstrapSession: entry route before the auth guard", () => {
  const cases: Array<{
    id: string;
    pathname: string;
    search: string;
    routes: Record<string, RouteReply>;
    route: unknown;
    status: string;
    replacedUrl: string | null;
  }> = [
    {
      id: "invite_link_routes_to_redemption_strips_token_and_restores_session",
      pathname: "/play",
      search: "?invite=abc123&lang=fr",
      routes: { "GET /api/v1/auth/me": ME_401 },
      route: { kind: "invite", token: "abc123" },
      status: "anonymous",
      replacedUrl: "/play?lang=fr",
    },
    {
      id: "setup_path_routes_to_owner_setup_and_leaves_setup_path",
      pathname: "/setup",
      search: "?token=feedface",
      routes: { "GET /api/v1/auth/me": ME_401 },
      route: { kind: "setup", token: "feedface" },
      status: "anonymous",
      replacedUrl: "/",
    },
    {
      id: "setup_path_without_token_still_routes_to_setup",
      pathname: "/setup",
      search: "",
      routes: { "GET /api/v1/auth/me": ME_401 },
      route: { kind: "setup", token: "" },
      status: "anonymous",
      replacedUrl: "/",
    },
    {
      id: "plain_url_restores_the_session_via_auth_me",
      pathname: "/play",
      search: "",
      routes: { "GET /api/v1/auth/me": ME_OK },
      route: { kind: "app" },
      status: "authenticated",
      replacedUrl: null,
    },
    {
      id: "identity_query_parameters_are_ignored",
      pathname: "/play",
      search: "?user_id=evil&role=GM&token=abc",
      routes: { "GET /api/v1/auth/me": ME_401 },
      route: { kind: "app" },
      status: "anonymous",
      replacedUrl: null,
    },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      const { client, state, transport } = newClient(c.routes);
      let replaced: string | null = null;
      const route = await bootstrapSession(client, { pathname: c.pathname, search: c.search, hash: "" }, (url) => {
        replaced = url;
      });
      assert.deepEqual(route, c.route);
      assert.deepEqual(transport.calls.map((call) => `${call.method} ${call.url}`), ["GET /api/v1/auth/me"]);
      assert.equal(state.status.value, c.status);
      assert.equal(replaced, c.replacedUrl);
    });
  }

  it("stripBootSecrets keeps unrelated parameters and the hash", () => {
    assert.equal(stripBootSecrets({ pathname: "/", search: "?a=1&invite=x&b=2", hash: "#top" }), "/?a=1&b=2#top");
  });

  it("setup path wins over an invite parameter", () => {
    assert.deepEqual(readBootRoute({ pathname: "/setup", search: "?token=t&invite=i", hash: "" }), { kind: "setup", token: "t" });
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

  async function mount(client: ApiClient, search = "", pathname = "/play") {
    container = doc.createElement("div");
    doc.body.appendChild(container);
    render(h(App, { client, location: { ...loc(search), pathname }, replaceUrl: () => undefined }), container);
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
      id: "invite link opens the InviteRedemption screen instead of the sign-in form",
      routes: { "GET /api/v1/auth/me": ME_401, "POST /api/v1/invites/preview": PREVIEW_ACTIVE },
      search: "?invite=abc",
      visible: "invite-redemption-screen",
      hidden: "auth-screen",
    },
  ];

  for (const c of screenCases) {
    it(c.id, async () => {
      const { client } = newClient(c.routes);
      await mount(client, c.search);
      assert.ok(byTestId(c.visible), `expected ${c.visible}`);
      assertAbsent(byTestId(c.hidden), c.hidden);
    });
  }

  it("setup path opens the owner setup screen", async () => {
    const { client } = newClient({
      "GET /api/v1/auth/me": ME_401,
      "POST /api/v1/instance/bootstrap/status": { status: 200, body: { status: "valid" } },
    });
    await mount(client, "?token=feedface", "/setup");
    assert.ok(byTestId("owner-setup-screen"));
    assertAbsent(byTestId("auth-screen"), "auth-screen");
  });

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

  const registrationCases: Array<{ id: string; instance: RouteReply | null; registerVisible: boolean; inviteOnlyVisible: boolean }> = [
    { id: "registration_open_offers_create_account_mode", instance: REGISTRATION_OPEN, registerVisible: true, inviteOnlyVisible: false },
    { id: "registration_closed_hides_create_account_mode", instance: REGISTRATION_CLOSED, registerVisible: false, inviteOnlyVisible: true },
    { id: "instance_info_failure_fails_closed_to_sign_in_only", instance: null, registerVisible: false, inviteOnlyVisible: true },
  ];

  for (const c of registrationCases) {
    it(c.id, async () => {
      const routes: Record<string, RouteReply> = { "GET /api/v1/auth/me": ME_401 };
      if (c.instance) routes["GET /api/v1/instance"] = c.instance;
      const { client } = newClient(routes);
      await mount(client);
      assert.equal(Boolean(byTestId("auth-mode-register")), c.registerVisible);
      assert.equal(Boolean(byTestId("auth-invite-only")), c.inviteOnlyVisible);
    });
  }

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

  it("creating a campaign appends it to the lobby list", async () => {
    const { client, transport } = newClient({
      "GET /api/v1/auth/me": ME_OK,
      "GET /api/v1/campaigns": { status: 200, body: { campaigns: [] } },
      "POST /api/v1/campaigns": { status: 201, body: { campaign: campaignDto({ name: "Shadows Over Thornvale" }) } },
    });
    await mount(client);
    typeInto("lobby-campaign-name", "  Shadows Over Thornvale ");
    byTestId("lobby-create-form").dispatchEvent({ type: "submit" });
    await flush(5);
    assert.deepEqual(transport.calls.find((call) => call.method === "POST")?.body, { name: "Shadows Over Thornvale" });
    assert.ok(byTestId(`lobby-campaign-${CAMPAIGN_ID}`));
  });

  it("invited player creates an account and lands in the workspace with the room socket connected", async () => {
    const { client, state, transport } = newClient({
      "GET /api/v1/auth/me": ME_401,
      "POST /api/v1/invites/preview": PREVIEW_ACTIVE,
      "POST /api/v1/invites/redeem": REDEEM_CREATED,
      "GET /api/v1/campaigns": { status: 200, body: { campaigns: [campaignDto({ role: "PLAYER" })] } },
    });
    await mount(client, "?invite=abc");
    typeInto("invite-display-name", "Lyra");
    typeInto("invite-email", "pc@example.test");
    typeInto("invite-password", "correct horse battery");
    byTestId("invite-form").dispatchEvent({ type: "submit" });
    await flush(6);

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

  it("the campaign view shows refused-action toasts and the reconnecting banner after a deploy close", async () => {
    const { client, transport } = newClient({
      "GET /api/v1/auth/me": ME_401,
      "POST /api/v1/invites/preview": PREVIEW_ACTIVE,
      "POST /api/v1/invites/redeem": REDEEM_CREATED,
      "GET /api/v1/campaigns": { status: 200, body: { campaigns: [campaignDto({ role: "PLAYER" })] } },
    });
    await mount(client, "?invite=abc");
    typeInto("invite-display-name", "Lyra");
    typeInto("invite-email", "pc@example.test");
    typeInto("invite-password", "correct horse battery");
    byTestId("invite-form").dispatchEvent({ type: "submit" });
    await flush(6);
    transport.sockets[0].open();
    transport.sockets[0].receive({ CommandRejected: { reason: "Not your turn" } });
    await flush();
    assert.match(byTestId("command-feedback-item").textContent, /^Action was refused: Not your turn/);

    transport.sockets[0].serverClose(1001);
    await flush();
    assert.equal(byTestId("connection-banner").getAttribute("data-state"), "reconnecting");
    assert.match(byTestId("connection-banner-message").textContent, /Connection lost\. Reconnecting, attempt 1\./);
    assert.equal(byTestId("trame-status-badge").textContent, "Reconnecting...");
    client.disconnect();
  });

  /** Holds requests whose URL ends with `suffix` until `release()` is called. */
  function gateRequests(transport: { fetch: (url: string, init: RequestInit) => Promise<Response> }, suffix: string) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = transport.fetch.bind(transport);
    transport.fetch = async (url: string, init: RequestInit) => {
      if (url.endsWith(suffix)) await gate;
      return original(url, init);
    };
    return () => release();
  }

  it("campaign list exposes role='list' so list semantics survive list-style: none", async () => {
    const { client } = newClient({ "GET /api/v1/auth/me": ME_OK, "GET /api/v1/campaigns": { status: 200, body: { campaigns: [campaignDto()] } } });
    await mount(client);
    assert.equal(byTestId(`lobby-campaign-${CAMPAIGN_ID}`).parentNode.getAttribute("role"), "list");
  });

  it("empty lobby renders the cartographic AtlasEmptyState with a localized heading", async () => {
    const { client } = newClient({ "GET /api/v1/auth/me": ME_OK, "GET /api/v1/campaigns": { status: 200, body: { campaigns: [] } } });
    await mount(client);
    const empty = byTestId("lobby-empty");
    assert.equal(empty.getAttribute("data-empty-state"), "campaigns");
    assert.ok(empty.querySelector("svg"), "empty state must include the illustration");
    assert.ok(empty.textContent.includes("No campaigns yet"));
  });

  const titleFocusCases: Array<{ id: string; routes: Record<string, RouteReply>; title: string }> = [
    { id: "sign-in screen focuses its h1 on mount", routes: { "GET /api/v1/auth/me": ME_401 }, title: "auth-title" },
    {
      id: "lobby focuses its h1 on mount",
      routes: { "GET /api/v1/auth/me": ME_OK, "GET /api/v1/campaigns": { status: 200, body: { campaigns: [] } } },
      title: "lobby-title",
    },
  ];

  for (const c of titleFocusCases) {
    it(c.id, async () => {
      const { client } = newClient(c.routes);
      await mount(client);
      assert.equal(doc.activeElement?.id, c.title);
    });
  }

  const authErrorCases: Array<{ id: string; mode: string; route: string; reply: RouteReply; invalid: string[] }> = [
    { id: "wrong credentials flag email and password", mode: "login", route: "POST /api/v1/auth/login", reply: { status: 401, body: { code: "INVALID_CREDENTIALS", error: "bad" } }, invalid: ["auth-email", "auth-password"] },
    { id: "taken email flags only the email field", mode: "register", route: "POST /api/v1/auth/register", reply: { status: 409, body: { code: "EMAIL_ALREADY_EXISTS", error: "taken" } }, invalid: ["auth-email"] },
    { id: "bad display name flags only the display name", mode: "register", route: "POST /api/v1/auth/register", reply: { status: 400, body: { code: "INVALID_DISPLAY_NAME", error: "short" } }, invalid: ["auth-display-name"] },
    { id: "generic server error flags no field", mode: "login", route: "POST /api/v1/auth/login", reply: { status: 500, body: { error: "boom" } }, invalid: [] },
  ];

  for (const c of authErrorCases) {
    it(c.id, async () => {
      const { client } = newClient({ "GET /api/v1/auth/me": ME_401, "GET /api/v1/instance": REGISTRATION_OPEN, [c.route]: c.reply });
      await mount(client);
      if (c.mode === "register") {
        byTestId("auth-mode-register").dispatchEvent({ type: "click" });
        await flush(1);
      }
      byTestId("auth-form").dispatchEvent({ type: "submit" });
      await flush(5);
      assert.equal(byTestId("auth-error").id, "auth-error");
      for (const field of ["auth-email", "auth-display-name", "auth-password"]) {
        const input = byTestId(field);
        if (!input) continue;
        const flagged = c.invalid.includes(field);
        assert.equal(input.getAttribute("aria-invalid"), flagged ? "true" : null, `${field} aria-invalid`);
        assert.equal(input.getAttribute("aria-describedby"), flagged ? "auth-error" : null, `${field} aria-describedby`);
      }
    });
  }

  it("submit stays focusable (aria-disabled + aria-busy) and mode buttons lock while signing in", async () => {
    const { client, transport } = newClient({
      "GET /api/v1/auth/me": ME_401,
      "GET /api/v1/instance": REGISTRATION_OPEN,
      "POST /api/v1/auth/login": { status: 401, body: { code: "INVALID_CREDENTIALS", error: "bad" } },
    });
    const release = gateRequests(transport, "/auth/login");
    await mount(client);
    byTestId("auth-form").dispatchEvent({ type: "submit" });
    await flush(2);
    const submit = byTestId("auth-submit");
    assert.equal(submit.getAttribute("aria-busy"), "true");
    assert.equal(submit.getAttribute("aria-disabled"), "true");
    assert.equal(submit.hasAttribute("disabled"), false);
    assert.equal(byTestId("auth-mode-login").disabled, true);
    assert.equal(byTestId("auth-mode-register").disabled, true);
    byTestId("auth-form").dispatchEvent({ type: "submit" });
    release();
    await flush(5);
    assert.equal(transport.calls.filter((call) => call.url === "/api/v1/auth/login").length, 1, "busy submit must not resend");
  });

  it("selected auth mode carries a non-color check glyph", async () => {
    const { client } = newClient({ "GET /api/v1/auth/me": ME_401, "GET /api/v1/instance": REGISTRATION_OPEN });
    await mount(client);
    assert.ok(byTestId("auth-mode-login").textContent.startsWith("✓"));
    assert.equal(byTestId("auth-mode-register").textContent.includes("✓"), false);
  });

  it("sign-in screen offers the language switch labelled in the target language", async () => {
    const { client } = newClient({ "GET /api/v1/auth/me": ME_401 });
    await mount(client);
    const toggle = byTestId("auth-screen").querySelector("[data-testid='header-locale-toggle']");
    assert.ok(toggle, "locale switch must render before sign-in");
    assert.equal(toggle.textContent, "Français");
    assert.equal(toggle.getAttribute("lang"), "fr");
  });
});
