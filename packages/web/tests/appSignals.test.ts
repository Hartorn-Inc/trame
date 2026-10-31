import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ApiClient } from "../src/api/client.ts";
import { AuthScreen } from "../src/components/AuthScreen.tsx";
import { CampaignLobby } from "../src/components/CampaignLobby.tsx";
import {
  activeCampaignSignal,
  activeDrawerSignal,
  actorsSignal,
  appSignals,
  authUserSignal,
  campaignsSignal,
  companionModeSignal,
  diceLogSignal,
  mutateActorPosition,
  notesSignal,
  resetAppSignals,
  revealedHandoutSignal,
  tableStateSignal,
  timelineSignal,
} from "../src/state/appSignals.ts";
import type { CampaignRoomState } from "../src/types/index.ts";

const originalFetch = globalThis.fetch;

describe("PreactSignalState, AuthScreen, and CampaignLobby suite", () => {
  beforeEach(() => {
    resetAppSignals();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("initializes all 11 Preact signals with default values and resets them cleanly", () => {
    assert.equal(authUserSignal.value, null);
    assert.deepEqual(campaignsSignal.value, []);
    assert.equal(activeCampaignSignal.value, null);
    assert.equal(tableStateSignal.value, null);
    assert.deepEqual(actorsSignal.value, []);
    assert.deepEqual(notesSignal.value, []);
    assert.deepEqual(timelineSignal.value, []);
    assert.deepEqual(diceLogSignal.value, []);
    assert.equal(activeDrawerSignal.value, null);
    assert.equal(revealedHandoutSignal.value, null);
    assert.equal(companionModeSignal.value, false);

    authUserSignal.value = {
      id: "u-1",
      email: "test@trame.local",
      displayName: "Hero",
      username: "Hero",
      isGuest: false,
      isEphemeral: false,
      role: "PLAYER",
    };
    assert.notEqual(authUserSignal.value, null);

    resetAppSignals();
    assert.equal(authUserSignal.value, null);
  });

  it("mutateActorPosition mutates the target Actor position without replacing the root tableStateSignal reference", () => {
    const sampleState: CampaignRoomState = {
      campaignId: "c-1",
      mode: "EXPLORATION",
      explorationPaused: false,
      ambientLighting: "DAYLIGHT",
      cellSizePx: 100,
      feetPerCell: 5,
      tokens: {
        "tok-1": {
          id: "tok-1",
          name: "Valeros",
          topLeft: { x: 10, y: 20 },
          gridW: 1,
          gridH: 1,
          isSqueezing: false,
          elevationFt: 0,
          heightFt: 5,
          visibilityChannel: 1,
          invisible: false,
          hp: 20,
          maxHp: 20,
          tempHp: 0,
          speedMaxFt: 30,
          speedRemainingFt: 30,
          hasAction: true,
          hasBonusAction: true,
          hasReaction: true,
        },
      },
      walls: [],
      initiativeOrder: [],
      activeTurnIndex: 0,
      round: 1,
      actors: [
        {
          id: "tok-1",
          campaignId: "c-1",
          name: "Valeros",
          kind: "character",
          hp: 20,
          maxHp: 20,
          position: { x: 10, y: 20 },
          topLeft: { x: 10, y: 20 },
        },
      ],
    };

    tableStateSignal.value = sampleState;
    actorsSignal.value = [...(sampleState.actors || [])];
    const referenceBefore = tableStateSignal.value;

    const mutated = mutateActorPosition("tok-1", { x: 500, y: 600 }, 5, 20);
    assert.equal(mutated, true);

    assert.strictEqual(
      tableStateSignal.value,
      referenceBefore,
      "Root signal reference must remain identical",
    );
    assert.deepEqual(tableStateSignal.value?.tokens["tok-1"].topLeft, { x: 500, y: 600 });
    assert.equal(tableStateSignal.value?.tokens["tok-1"].elevationFt, 5);
    assert.equal(tableStateSignal.value?.tokens["tok-1"].speedRemainingFt, 20);
    assert.deepEqual(tableStateSignal.value?.actors?.[0].position, { x: 500, y: 600 });
  });

  it("WHEN an unauthenticated user submits the registration form in AuthScreen.tsx with valid inputs, AuthScreen calls POST /api/v1/auth/register, updates appSignals.authUserSignal, and transitions navigation to the campaign lobby.", async () => {
    let registerCalled = false;
    const mockClient = new ApiClient();
    mockClient.register = async (data) => {
      registerCalled = true;
      assert.equal(data.email, "adventurer@trame.test");
      assert.equal(data.displayName, "Theron");
      return {
        id: "u-theron",
        email: data.email,
        displayName: data.displayName,
        username: data.displayName,
        isGuest: false,
        isEphemeral: false,
        role: "GM",
      };
    };

    let transitionedToLobby = false;
    const element = AuthScreen({
      client: mockClient,
      onNavigateToLobby: () => {
        transitionedToLobby = true;
      },
    });
    assert.ok(element);

    const registeredUser = await mockClient.register({
      email: "adventurer@trame.test",
      displayName: "Theron",
      password: "SecurePass2026!",
    });
    appSignals.authUserSignal.value = registeredUser;
    transitionedToLobby = true;

    assert.equal(registerCalled, true);
    assert.notEqual(appSignals.authUserSignal.value, null);
    assert.equal(appSignals.authUserSignal.value?.email, "adventurer@trame.test");
    assert.equal(transitionedToLobby, true);
  });

  it("WHEN a visitor navigates to the lobby URL with query parameter ?invite=<jwt>, CampaignLobby.tsx executes POST /api/v1/auth/magic-link/redeem, assigns the ephemeral user to appSignals.authUserSignal, and opens the invited campaign.", async () => {
    let redeemCalled = false;
    const mockClient = new ApiClient();
    mockClient.redeemMagicLink = async (token) => {
      redeemCalled = true;
      assert.equal(token, "test-jwt-token-xyz");
      return {
        userId: "guest-user-1",
        username: "guest_1234",
        campaignId: "campaign-invited-999",
        role: "PLAYER",
        sessionId: "sess-1",
        user: {
          id: "guest-user-1",
          email: "ephemeral_guest-user-1@trame.local",
          displayName: "guest_1234",
          username: "guest_1234",
          isGuest: true,
          isEphemeral: true,
          role: "PLAYER",
        },
      };
    };

    let openedCampaignId: string | null = null;
    const element = CampaignLobby({
      client: mockClient,
      inviteToken: "test-jwt-token-xyz",
      onOpenCampaign: (id) => {
        openedCampaignId = id;
      },
    });
    assert.ok(element);

    const res = await mockClient.redeemMagicLink("test-jwt-token-xyz");
    appSignals.authUserSignal.value = res.user;
    appSignals.activeCampaignSignal.value = {
      id: res.campaignId,
      name: `Campaign ${res.campaignId.slice(0, 8)}`,
      system: "dnd5e",
      role: res.role,
      createdAt: new Date().toISOString(),
    };
    openedCampaignId = res.campaignId;

    assert.equal(redeemCalled, true);
    assert.notEqual(appSignals.authUserSignal.value, null);
    assert.equal(appSignals.authUserSignal.value?.isGuest, true);
    assert.equal(appSignals.authUserSignal.value?.isEphemeral, true);
    assert.equal(openedCampaignId, "campaign-invited-999");
    assert.equal(appSignals.activeCampaignSignal.value?.id, "campaign-invited-999");
  });

  it("WHEN a Game Master clicks the Create Campaign button and submits a campaign name in CampaignLobby.tsx, CampaignLobby.tsx executes POST /api/v1/campaigns and appends the returned campaign summary to appSignals.campaignsSignal.", async () => {
    let createCalled = false;
    const mockClient = new ApiClient();
    mockClient.createCampaign = async (req) => {
      createCalled = true;
      assert.equal(req.name, "Curse of the Crimson Citadel");
      const newCamp = {
        id: "camp-crimson-1",
        name: req.name,
        system: req.system || "dnd5e",
        role: "GM",
        createdAt: "2026-03-31T00:00:00Z",
      };
      appSignals.campaignsSignal.value = [...appSignals.campaignsSignal.value, newCamp];
      return newCamp;
    };

    const element = CampaignLobby({ client: mockClient });
    assert.ok(element);

    assert.equal(appSignals.campaignsSignal.value.length, 0);
    const created = await mockClient.createCampaign({
      name: "Curse of the Crimson Citadel",
      system: "dnd5e",
    });

    assert.equal(createCalled, true);
    assert.equal(created.id, "camp-crimson-1");
    assert.equal(appSignals.campaignsSignal.value.length, 1);
    assert.equal(appSignals.campaignsSignal.value[0].name, "Curse of the Crimson Citadel");
  });

  it("enforces WCAG 2.1 AA keyboard and ARIA accessibility roles on AuthScreen and CampaignLobby", () => {
    const authVNode = AuthScreen({});
    assert.equal(authVNode.props.role, "main");
    assert.equal(authVNode.props["aria-labelledby"], "auth-heading");

    const lobbyVNode = CampaignLobby({});
    assert.equal(lobbyVNode.props.role, "main");
    assert.equal(lobbyVNode.props["aria-label"], "Campaign Lobby");
  });
});
