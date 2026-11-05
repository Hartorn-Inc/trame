// Seam 5: account, instance and invite screens rendered in `App` against a mocked transport.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { h, options, render } from "preact";
import { ApiClient } from "../src/api/client.ts";
import { createSessionState } from "../src/api/session.ts";
import { localeSignal, t } from "../src/i18n/index.ts";
import { setupMockDom } from "./helpers/mockDom.ts";
import { authUserDto, campaignDto, createMockTransport, flush, type RouteReply } from "./helpers/mockTransport.ts";

localeSignal.value = "en";
options.debounceRendering = (cb: () => void) => cb();
options.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
const doc = setupMockDom() as any;
(globalThis as any).innerWidth = 1280;
(globalThis as any).addEventListener = () => undefined;
(globalThis as any).removeEventListener = () => undefined;
const { App } = await import("../src/App.tsx");

const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PLAYER_ID = "33333333-3333-4333-8333-333333333333";
const CAMPAIGNS = `/api/v1/campaigns/${CAMPAIGN_ID}`;
const ME_401: RouteReply = { status: 401, body: { code: "UNAUTHORIZED", error: "no session" } };
const me = (overrides: Record<string, unknown> = {}): RouteReply => ({ status: 200, body: { user: authUserDto(overrides) } });
const err = (status: number, code: string): RouteReply => ({ status, body: { code, error: code.toLowerCase() } });
const NO_CAMPAIGNS: RouteReply = { status: 200, body: { campaigns: [] } };

let container: any = null;

afterEach(() => {
  if (container) {
    render(null, container);
    doc.body.removeChild(container);
    container = null;
  }
});

async function mount(routes: Record<string, RouteReply>, entry: { pathname?: string; search?: string } = {}) {
  const transport = createMockTransport(routes);
  const state = createSessionState();
  const client = new ApiClient({ transport, state, wsOrigin: "ws://table.test" });
  container = doc.createElement("div");
  doc.body.appendChild(container);
  const location = { pathname: entry.pathname ?? "/", search: entry.search ?? "", hash: "" };
  render(h(App, { client, location, replaceUrl: () => undefined }), container);
  await flush(6);
  return { client, state, transport };
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

function typeInto(id: string, value: string) {
  const input = byTestId(id);
  assert.ok(input, `missing input ${id}`);
  input.value = value;
  input.dispatchEvent({ type: "input" });
}

async function act(id: string, type: "click" | "submit" = "click") {
  const node = byTestId(id);
  assert.ok(node, `missing ${id}`);
  node.dispatchEvent({ type });
  await flush(6);
}

const callsTo = (transport: { calls: Array<{ method: string; url: string; body: unknown }> }, key: string) =>
  transport.calls.filter((call) => `${call.method} ${call.url}` === key);

describe("OwnerSetupScreen (/setup?token=)", () => {
  const cases: Array<{
    id: string;
    search: string;
    status: RouteReply | null;
    bootstrap: RouteReply | null;
    visible: string;
    hidden: string;
    bootstrapCalls: number;
  }> = [
    {
      id: "setup_valid_token_creates_owner_and_lands_in_lobby",
      search: "?token=feedface",
      status: { status: 200, body: { status: "valid" } },
      bootstrap: { status: 201, body: { user: authUserDto({ id: OWNER_ID, instance_role: "OWNER" }) } },
      visible: "campaign-lobby",
      hidden: "owner-setup-screen",
      bootstrapCalls: 1,
    },
    {
      id: "setup_expired_token_shows_error",
      search: "?token=feedface",
      status: { status: 200, body: { status: "expired" } },
      bootstrap: null,
      visible: "setup-expired",
      hidden: "setup-form",
      bootstrapCalls: 0,
    },
    {
      id: "setup_unknown_token_shows_invalid",
      search: "?token=feedface",
      status: { status: 200, body: { status: "invalid" } },
      bootstrap: null,
      visible: "setup-invalid",
      hidden: "setup-form",
      bootstrapCalls: 0,
    },
    {
      id: "setup_missing_token_shows_invalid_without_a_request",
      search: "",
      status: null,
      bootstrap: null,
      visible: "setup-invalid",
      hidden: "setup-form",
      bootstrapCalls: 0,
    },
    {
      id: "setup_status_check_failure_offers_explanation",
      search: "?token=feedface",
      status: { status: 500, body: { error: "boom" } },
      bootstrap: null,
      visible: "setup-checkFailed",
      hidden: "setup-form",
      bootstrapCalls: 0,
    },
    {
      id: "setup_owner_already_claimed_on_submit_ends_the_form",
      search: "?token=feedface",
      status: { status: 200, body: { status: "valid" } },
      bootstrap: err(409, "OWNER_EXISTS"),
      visible: "setup-invalid",
      hidden: "setup-form",
      bootstrapCalls: 1,
    },
    {
      id: "setup_token_expiring_during_submit_shows_expired",
      search: "?token=feedface",
      status: { status: 200, body: { status: "valid" } },
      bootstrap: err(410, "SETUP_TOKEN_EXPIRED"),
      visible: "setup-expired",
      hidden: "setup-form",
      bootstrapCalls: 1,
    },
    {
      id: "setup_weak_password_keeps_the_form_with_an_alert",
      search: "?token=feedface",
      status: { status: 200, body: { status: "valid" } },
      bootstrap: err(400, "WEAK_PASSWORD"),
      visible: "setup-error",
      hidden: "campaign-lobby",
      bootstrapCalls: 1,
    },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      const routes: Record<string, RouteReply> = { "GET /api/v1/auth/me": ME_401, "GET /api/v1/campaigns": NO_CAMPAIGNS };
      if (c.status) routes["POST /api/v1/instance/bootstrap/status"] = c.status;
      if (c.bootstrap) routes["POST /api/v1/instance/bootstrap"] = c.bootstrap;
      const { transport } = await mount(routes, { pathname: "/setup", search: c.search });
      if (byTestId("setup-form")) {
        typeInto("setup-email", "owner@example.test");
        typeInto("setup-display-name", "Morgan");
        typeInto("setup-password", "correct horse battery");
        await act("setup-form", "submit");
      }
      assert.ok(byTestId(c.visible), `expected ${c.visible}`);
      assert.equal(byTestId(c.hidden), null, `expected ${c.hidden} hidden`);
      assert.equal(callsTo(transport, "POST /api/v1/instance/bootstrap").length, c.bootstrapCalls);
    });
  }

  it("setup_locked_email_is_prefilled_read_only_and_sent", async () => {
    const { transport } = await mount(
      {
        "GET /api/v1/auth/me": ME_401,
        "POST /api/v1/instance/bootstrap/status": { status: 200, body: { status: "valid", locked_email: "owner@example.test" } },
        "POST /api/v1/instance/bootstrap": { status: 201, body: { user: authUserDto({ instance_role: "OWNER" }) } },
        "GET /api/v1/campaigns": NO_CAMPAIGNS,
      },
      { pathname: "/setup", search: "?token=feedface" },
    );
    const email = byTestId("setup-email");
    assert.equal(email.value, "owner@example.test");
    assert.equal(Boolean(email.readOnly || email.hasAttribute("readonly")), true);
    typeInto("setup-display-name", "Morgan");
    typeInto("setup-password", "correct horse battery");
    await act("setup-form", "submit");
    assert.deepEqual(callsTo(transport, "POST /api/v1/instance/bootstrap")[0].body, {
      token: "feedface",
      email: "owner@example.test",
      password: "correct horse battery",
      display_name: "Morgan",
    });
  });
});

describe("CampaignLobby gating by InstanceRole", () => {
  const cases: Array<{ id: string; role: string; canCreate: boolean; adminButton: boolean }> = [
    { id: "member_cannot_see_create_campaign", role: "MEMBER", canCreate: false, adminButton: false },
    { id: "host_sees_create_campaign", role: "HOST", canCreate: true, adminButton: false },
    { id: "owner_sees_create_campaign_and_account_admin", role: "OWNER", canCreate: true, adminButton: true },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      await mount({ "GET /api/v1/auth/me": me({ instance_role: c.role }), "GET /api/v1/campaigns": NO_CAMPAIGNS });
      assert.equal(Boolean(byTestId("lobby-create-form")), c.canCreate);
      assert.equal(Boolean(byTestId("lobby-create-restricted")), !c.canCreate);
      assert.equal(Boolean(byTestId("header-instance-admin")), c.adminButton);
      assert.ok(byTestId("header-account"), "account settings are reachable from the lobby");
    });
  }
});

describe("InstanceAdminPanel (Owner)", () => {
  const users = [
    { id: OWNER_ID, email: "owner@example.test", display_name: "Morgan", instance_role: "OWNER", is_guest: false, totp_enabled: true, created_at: 1 },
    { id: PLAYER_ID, email: "pc@example.test", display_name: "Lyra", instance_role: "MEMBER", is_guest: false, totp_enabled: false, created_at: 2 },
    { id: "44444444-4444-4444-8444-444444444444", email: "h@example.test", display_name: "Hale", instance_role: "HOST", is_guest: false, totp_enabled: false, created_at: 3 },
  ];

  const cases: Array<{ id: string; userId: string; sent: string; reply: RouteReply; badge: string; alert: boolean }> = [
    {
      id: "owner_promotes_host",
      userId: PLAYER_ID,
      sent: "HOST",
      reply: { status: 200, body: { user: { ...users[1], instance_role: "HOST" } } },
      badge: "Host",
      alert: false,
    },
    {
      id: "owner_demotes_host_to_member",
      userId: users[2].id,
      sent: "MEMBER",
      reply: { status: 200, body: { user: { ...users[2], instance_role: "MEMBER" } } },
      badge: "Member",
      alert: false,
    },
    {
      id: "role_change_failure_shows_row_alert_and_keeps_badge",
      userId: PLAYER_ID,
      sent: "HOST",
      reply: err(409, "CANNOT_CHANGE_OWNER"),
      badge: "Member",
      alert: true,
    },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      const { transport } = await mount({
        "GET /api/v1/auth/me": me({ id: OWNER_ID, instance_role: "OWNER" }),
        "GET /api/v1/campaigns": NO_CAMPAIGNS,
        "GET /api/v1/instance/users": { status: 200, body: { users } },
        [`PUT /api/v1/instance/users/${c.userId}/role`]: c.reply,
      });
      await act("header-instance-admin");
      assert.ok(byTestId("instance-admin"));
      assert.equal(byTestId(`admin-role-${OWNER_ID}`), null, "the Owner row offers no role change");
      await act(`admin-role-${c.userId}`);
      assert.deepEqual(callsTo(transport, `PUT /api/v1/instance/users/${c.userId}/role`)[0].body, { instance_role: c.sent });
      assert.equal(byTestId(`admin-role-badge-${c.userId}`).textContent, c.badge);
      assert.equal(Boolean(byTestId(`admin-error-${c.userId}`)), c.alert);
    });
  }
});

describe("CampaignInviteDialog (GM)", () => {
  const INVITE = {
    id: "55555555-5555-4555-8555-555555555555",
    campaign_id: CAMPAIGN_ID,
    created_at: 1_800_000_000,
    expires_at: 1_800_086_400,
    max_uses: 5,
    use_count: 0,
    revoked_at: null,
    status: "active",
  };
  const REDEMPTION = { invite_id: INVITE.id, campaign_id: CAMPAIGN_ID, user_id: PLAYER_ID, display_name: "Lyra", redeemed_at: 1_800_000_100 };
  const MEMBERS = {
    status: 200,
    body: {
      members: [
        { user_id: OWNER_ID, display_name: "Morgan", role: "GM" },
        { user_id: PLAYER_ID, display_name: "Lyra", role: "PLAYER" },
      ],
    },
  };

  function inviteRoutes(extra: Record<string, RouteReply> = {}): Record<string, RouteReply> {
    return {
      "GET /api/v1/auth/me": me({ id: OWNER_ID }),
      "GET /api/v1/campaigns": { status: 200, body: { campaigns: [campaignDto()] } },
      [`GET ${CAMPAIGNS}/invites/active`]: { status: 200, body: { invite: null } },
      [`GET ${CAMPAIGNS}/invites/redemptions`]: { status: 200, body: { redemptions: [REDEMPTION] } },
      [`GET ${CAMPAIGNS}/members`]: MEMBERS,
      ...extra,
    };
  }

  it("invite_create_revoke_lists_redemptions", async () => {
    const { transport } = await mount(
      inviteRoutes({
        [`POST ${CAMPAIGNS}/invites`]: {
          status: 201,
          body: { invite: { ...INVITE, invite_url: "https://trame.test/?invite=abc", token: "abc" } },
        },
        [`DELETE ${CAMPAIGNS}/invites/active`]: { status: 200, body: { invite: { ...INVITE, status: "revoked", revoked_at: 1_800_000_200 } } },
      }),
    );
    await act(`lobby-invite-${CAMPAIGN_ID}`);
    assert.equal(byTestId("invite-dialog").getAttribute("role"), "dialog");
    assert.ok(byTestId("invite-none"));
    assert.ok(byTestId(`redemption-${PLAYER_ID}`).textContent.includes("Lyra"));
    assert.equal(byTestId("invite-max-uses").value, "8", "max uses defaults to 8");

    byTestId("invite-ttl").value = "86400";
    byTestId("invite-ttl").dispatchEvent({ type: "change" });
    typeInto("invite-max-uses", "5");
    await act("invite-create-form", "submit");
    assert.deepEqual(callsTo(transport, `POST ${CAMPAIGNS}/invites`)[0].body, { ttl_seconds: 86400, max_uses: 5 });
    assert.equal(byTestId("invite-url").value, "https://trame.test/?invite=abc");
    assert.equal(byTestId("invite-status").textContent, "Active");
    assert.equal(byTestId("invite-uses").textContent, t("invites.uses", { used: 0, max: 5 }));
    assert.equal(byTestId("invite-dialog-status").textContent, t("invites.created"));

    await act("invite-revoke");
    assert.equal(callsTo(transport, `DELETE ${CAMPAIGNS}/invites/active`).length, 1);
    assert.equal(byTestId("invite-status").textContent, "Revoked");
    assert.equal(byTestId("invite-url"), null, "a revoked link is no longer shown");
    assert.equal(byTestId("invite-revoke"), null);
  });

  const maxUsesCases = [
    { id: "max_uses_zero_is_rejected_locally", value: "0" },
    { id: "max_uses_above_100_is_rejected_locally", value: "101" },
    { id: "max_uses_fraction_is_rejected_locally", value: "2.5" },
  ];

  for (const c of maxUsesCases) {
    it(c.id, async () => {
      const { transport } = await mount(inviteRoutes());
      await act(`lobby-invite-${CAMPAIGN_ID}`);
      typeInto("invite-max-uses", c.value);
      await act("invite-create-form", "submit");
      assert.ok(byTestId("invite-max-uses-error"));
      assert.equal(byTestId("invite-max-uses").getAttribute("aria-invalid"), "true");
      assert.equal(callsTo(transport, `POST ${CAMPAIGNS}/invites`).length, 0);
    });
  }

  it("gm_removes_member_after_confirmation", async () => {
    const { transport } = await mount(
      inviteRoutes({ [`DELETE ${CAMPAIGNS}/members/${PLAYER_ID}`]: { status: 200, body: { removed: true, disconnected_sessions: 1 } } }),
    );
    await act(`lobby-invite-${CAMPAIGN_ID}`);
    assert.equal(byTestId(`member-remove-${OWNER_ID}`), null, "the GM is never offered for removal");
    await act(`member-remove-${PLAYER_ID}`);
    assert.equal(callsTo(transport, `DELETE ${CAMPAIGNS}/members/${PLAYER_ID}`).length, 0, "first click only asks to confirm");
    assert.ok(byTestId(`member-remove-cancel-${PLAYER_ID}`));
    transport.routes[`GET ${CAMPAIGNS}/members`] = { status: 200, body: { members: [MEMBERS.body.members[0]] } };
    await act(`member-remove-${PLAYER_ID}`);
    assert.equal(callsTo(transport, `DELETE ${CAMPAIGNS}/members/${PLAYER_ID}`).length, 1);
    assert.ok(byTestId(`redemption-gone-${PLAYER_ID}`));
    assert.equal(byTestId("invite-dialog-status").textContent, t("invites.removed", { name: "Lyra" }));
  });

  it("escape_closes_the_invite_dialog", async () => {
    await mount(inviteRoutes());
    const inviteButton = byTestId(`lobby-invite-${CAMPAIGN_ID}`);
    // A browser focuses a clicked button; the mock DOM does not.
    inviteButton.focus();
    await act(`lobby-invite-${CAMPAIGN_ID}`);
    doc.dispatchEvent({ type: "keydown", key: "Escape" });
    await flush(3);
    assert.equal(byTestId("invite-dialog"), null);
    // Identity check: diffing two mock DOM nodes on failure exhausts memory.
    assert.ok(doc.activeElement === inviteButton, "focus returns to the invite button");
  });
});

describe("InviteRedemptionScreen (?invite=)", () => {
  const PREVIEW: RouteReply = {
    status: 200,
    body: { campaign_id: CAMPAIGN_ID, campaign_name: "Lost Mine", status: "active", expires_at: 1_900_000_000 },
  };
  const REDEEMED = (code: number, accountCreated: boolean): RouteReply => ({
    status: code,
    body: {
      campaign_id: CAMPAIGN_ID,
      role: "PLAYER",
      already_member: false,
      account_created: accountCreated,
      user: authUserDto({ id: PLAYER_ID, instance_role: "MEMBER", display_name: "Lyra" }),
    },
  });

  const cases: Array<{
    id: string;
    session: RouteReply;
    preview: RouteReply;
    redeem: RouteReply | null;
    action: "create" | "join" | "none";
    redeemBody: unknown;
    visible: string;
    message: string | null;
  }> = [
    {
      id: "redeem_logged_out_creates_account",
      session: ME_401,
      preview: PREVIEW,
      redeem: REDEEMED(201, true),
      action: "create",
      redeemBody: { token: "abc", email: "pc@example.test", password: "correct horse battery", display_name: "Lyra" },
      visible: "trame-app-root",
      message: null,
    },
    {
      id: "redeem_logged_in_joins",
      session: me({ id: PLAYER_ID, instance_role: "MEMBER" }),
      preview: PREVIEW,
      redeem: REDEEMED(200, false),
      action: "join",
      redeemBody: { token: "abc" },
      visible: "trame-app-root",
      message: null,
    },
    {
      id: "redeem_exhausted_shows_410_message",
      session: ME_401,
      preview: PREVIEW,
      redeem: err(410, "INVITE_EXHAUSTED"),
      action: "create",
      redeemBody: { token: "abc", email: "pc@example.test", password: "correct horse battery", display_name: "Lyra" },
      visible: "invite-unavailable",
      message: t("invite.unavailable.exhausted"),
    },
    {
      id: "redeem_email_taken_flags_email_and_keeps_form",
      session: ME_401,
      preview: PREVIEW,
      redeem: err(409, "EMAIL_ALREADY_EXISTS"),
      action: "create",
      redeemBody: { token: "abc", email: "pc@example.test", password: "correct horse battery", display_name: "Lyra" },
      visible: "invite-error",
      message: t("invite.error.emailTaken"),
    },
    {
      id: "preview_revoked_link_explains_without_form",
      session: ME_401,
      preview: { status: 200, body: { ...(PREVIEW.body as object), status: "revoked" } },
      redeem: null,
      action: "none",
      redeemBody: null,
      visible: "invite-unavailable",
      message: t("invite.unavailable.revoked"),
    },
    {
      id: "preview_unknown_token_shows_404_message",
      session: ME_401,
      preview: err(404, "INVITE_NOT_FOUND"),
      redeem: null,
      action: "none",
      redeemBody: null,
      visible: "invite-unavailable",
      message: t("invite.unavailable.notFound"),
    },
    {
      id: "preview_expired_410_shows_expired_message",
      session: ME_401,
      preview: err(410, "INVITE_EXPIRED"),
      redeem: null,
      action: "none",
      redeemBody: null,
      visible: "invite-unavailable",
      message: t("invite.unavailable.expired"),
    },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      const routes: Record<string, RouteReply> = {
        "GET /api/v1/auth/me": c.session,
        "POST /api/v1/invites/preview": c.preview,
        "GET /api/v1/campaigns": { status: 200, body: { campaigns: [campaignDto({ role: "PLAYER" })] } },
      };
      if (c.redeem) routes["POST /api/v1/invites/redeem"] = c.redeem;
      const { transport, state } = await mount(routes, { search: "?invite=abc" });
      assert.ok(byTestId("invite-redemption-screen"));
      assert.equal(byTestId("invite-alert-region").getAttribute("role"), "alert");

      if (c.action === "none") {
        assert.equal(byTestId("invite-form"), null);
        assert.equal(byTestId("invite-join"), null);
      } else if (c.action === "create") {
        assert.equal(byTestId("invite-join"), null, "signed-out visitors get the account form");
        typeInto("invite-display-name", "Lyra");
        typeInto("invite-email", "pc@example.test");
        typeInto("invite-password", "correct horse battery");
        await act("invite-form", "submit");
      } else {
        assert.equal(byTestId("invite-form"), null, "signed-in users only see Join");
        await act("invite-join");
      }

      assert.ok(byTestId(c.visible), `expected ${c.visible}`);
      if (c.message) assert.equal(byTestId(c.visible).textContent, c.message);
      const redeems = callsTo(transport, "POST /api/v1/invites/redeem");
      assert.deepEqual(redeems[0]?.body ?? null, c.redeemBody);
      if (c.visible === "trame-app-root") assert.equal(state.activeCampaignId.value, CAMPAIGN_ID);
    });
  }

  it("redeem_signed_out_visitor_can_sign_in_then_join", async () => {
    const { transport } = await mount(
      {
        "GET /api/v1/auth/me": ME_401,
        "POST /api/v1/invites/preview": PREVIEW,
        "POST /api/v1/auth/login": me({ id: PLAYER_ID, instance_role: "MEMBER" }),
        "POST /api/v1/invites/redeem": REDEEMED(200, false),
        "GET /api/v1/campaigns": { status: 200, body: { campaigns: [campaignDto({ role: "PLAYER" })] } },
      },
      { search: "?invite=abc" },
    );
    await act("invite-mode-signin");
    assert.equal(byTestId("invite-display-name"), null);
    typeInto("invite-email", "pc@example.test");
    typeInto("invite-password", "correct horse battery");
    await act("invite-form", "submit");
    assert.ok(byTestId("invite-join"));
    await act("invite-join");
    assert.deepEqual(callsTo(transport, "POST /api/v1/invites/redeem")[0].body, { token: "abc" });
    assert.ok(byTestId("trame-app-root"));
  });
});

describe("GuestBindPrompt (legacy guests)", () => {
  const cases = [
    { id: "guest_sees_bind_prompt", isGuest: true },
    { id: "registered_user_sees_no_bind_prompt", isGuest: false },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      await mount({ "GET /api/v1/auth/me": me({ is_guest: c.isGuest, email: "" }), "GET /api/v1/campaigns": NO_CAMPAIGNS });
      assert.equal(Boolean(byTestId("guest-bind-prompt")), c.isGuest);
    });
  }

  it("guest_bind_submits_credentials_and_hides_prompt", async () => {
    const { transport } = await mount({
      "GET /api/v1/auth/me": me({ is_guest: true, email: "" }),
      "GET /api/v1/campaigns": NO_CAMPAIGNS,
      "POST /api/v1/auth/bind": { status: 200, body: { user: authUserDto() } },
    });
    typeInto("bind-email", "gm@example.test");
    typeInto("bind-password", "correct horse battery");
    transport.routes["GET /api/v1/auth/me"] = me({ is_guest: false });
    await act("bind-form", "submit");
    assert.deepEqual(callsTo(transport, "POST /api/v1/auth/bind")[0].body, { email: "gm@example.test", password: "correct horse battery" });
    assert.equal(byTestId("guest-bind-prompt"), null);
  });
});

describe("AccountSettingsDialog TOTP recommendation", () => {
  const cases = [
    { id: "owner_without_totp_gets_strong_nudge", role: "OWNER", totp: false, visible: "account-totp-nudge-owner", text: t("account.totp.nudgeOwner") },
    { id: "member_without_totp_gets_nudge", role: "MEMBER", totp: false, visible: "account-totp-nudge", text: t("account.totp.nudge") },
    { id: "totp_enabled_shows_no_nudge", role: "HOST", totp: true, visible: "account-totp-enabled", text: t("account.totp.enabled") },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      await mount({ "GET /api/v1/auth/me": me({ instance_role: c.role, totp_enabled: c.totp }), "GET /api/v1/campaigns": NO_CAMPAIGNS });
      await act("header-account");
      assert.equal(byTestId("account-settings-dialog").getAttribute("aria-modal"), "true");
      assert.ok(byTestId(c.visible).textContent.includes(c.text));
      await act("account-close");
      assert.equal(byTestId("account-settings-dialog"), null);
    });
  }
});
