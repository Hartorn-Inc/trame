// Seam 5: connection banner and action feedback toasts (user stories 26-28) against a mocked transport.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { decode } from "@msgpack/msgpack";
import { h } from "preact";
import type { ConnectionStatus } from "../../src/api/session.ts";
import { CommandFeedbackToasts, ConnectionBanner } from "../../src/components/RoomConnectionFeedback.tsx";
import { localeSignal, type LocaleCode } from "../../src/i18n/index.ts";
import * as commands from "../../src/table/commands.ts";
import { CAMPAIGN, HERO, PLAYER_ID, liveTable, mount, tableState } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

setupMockDom();

afterEach(() => {
  localeSignal.value = "en";
});

describe("banner_a11y: ConnectionBanner states", () => {
  const cases: Array<{
    id: string;
    status: ConnectionStatus;
    attempt: number;
    nextRetryInMs: number | null;
    locale?: LocaleCode;
    visible: boolean;
    message: string;
    retry: string | null;
    button: string | null;
  }> = [
    {
      id: "banner_a11y: connected collapses to visually hidden status text",
      status: "open",
      attempt: 0,
      nextRetryInMs: null,
      visible: false,
      message: "Connected to the table.",
      retry: null,
      button: null,
    },
    {
      id: "banner_a11y: reconnecting names the attempt, counts down outside the live region, offers reconnect now",
      status: "reconnecting",
      attempt: 2,
      nextRetryInMs: 4000,
      visible: true,
      message: "Connection lost. Reconnecting, attempt 2.",
      retry: "Next try in 4 seconds.",
      button: "connection-reconnect-now",
    },
    {
      id: "banner_a11y: reconnecting with a retry in flight says so",
      status: "reconnecting",
      attempt: 1,
      nextRetryInMs: null,
      visible: true,
      message: "Connection lost. Reconnecting, attempt 1.",
      retry: "Trying now...",
      button: "connection-reconnect-now",
    },
    {
      id: "banner_a11y: offline explains the automatic resume",
      status: "offline",
      attempt: 0,
      nextRetryInMs: null,
      visible: true,
      message: "You are offline. TRAME reconnects when your network is back.",
      retry: null,
      button: "connection-reconnect-now",
    },
    {
      id: "banner_a11y: signed out offers sign in instead of retrying",
      status: "signedOut",
      attempt: 0,
      nextRetryInMs: null,
      visible: true,
      message: "Your session has expired. Sign in again to rejoin the table.",
      retry: null,
      button: "connection-sign-in",
    },
    {
      id: "banner_a11y: forbidden offers the way back to the campaign list",
      status: "forbidden",
      attempt: 0,
      nextRetryInMs: null,
      visible: true,
      message: "You no longer have access to this campaign.",
      retry: null,
      button: "connection-back-to-campaigns",
    },
    {
      id: "banner_a11y: French reconnecting banner with singular countdown",
      status: "reconnecting",
      attempt: 3,
      nextRetryInMs: 1000,
      locale: "fr",
      visible: true,
      message: "Connexion perdue. Reconnexion, tentative 3.",
      retry: "Prochaine tentative dans 1 seconde.",
      button: "connection-reconnect-now",
    },
  ];

  for (const c of cases) {
    it(c.id, () => {
      localeSignal.value = c.locale ?? "en";
      const live = liveTable(PLAYER_ID, tableState());
      live.client.disconnect();
      live.client.state.connection.value = c.status;
      live.client.state.reconnect.value = {
        attempt: c.attempt,
        nextRetryAtMs: c.nextRetryInMs === null ? null : Date.now() + c.nextRetryInMs,
      };
      const ui = mount(h(ConnectionBanner, { client: live.client }));
      const banner = ui.byTestId("connection-banner");
      const message = ui.byTestId("connection-banner-message");
      const retry = ui.byTestId("connection-banner-retry");

      assert.equal(banner.getAttribute("data-state"), c.status);
      assert.equal(banner.classList.contains("ds-connection-banner"), c.visible);
      assert.equal(banner.classList.contains("ds-visually-hidden"), !c.visible);
      assert.equal(message.getAttribute("role"), "status");
      assert.equal(message.getAttribute("aria-live"), "polite");
      assert.equal(message.getAttribute("aria-atomic"), "true");
      assert.equal(message.textContent, c.message, "the state is a full sentence, not a color");
      assert.equal(retry?.textContent ?? null, c.retry);
      if (retry) assert.equal(message.contains(retry), false, "countdown ticks are not announced");
      for (const id of ["connection-reconnect-now", "connection-sign-in", "connection-back-to-campaigns"]) {
        assert.equal(Boolean(ui.byTestId(id)), id === c.button, id);
        if (ui.byTestId(id)) assert.equal(message.contains(ui.byTestId(id)), false, "buttons sit outside the live region");
      }
      ui.unmount();
    });
  }
});

describe("ConnectionBanner actions", () => {
  const cases: Array<{ id: string; closeCode: number; button: string; check: (live: ReturnType<typeof liveTable>) => void }> = [
    {
      id: "reconnect now opens a new socket without waiting for the backoff",
      closeCode: 1001,
      button: "connection-reconnect-now",
      check: (live) => assert.equal(live.transport.sockets.length, 2),
    },
    {
      id: "sign in again returns to the sign-in screen and keeps the campaign to come back to",
      closeCode: 4401,
      button: "connection-sign-in",
      check: (live) => {
        assert.equal(live.client.state.status.value, "anonymous");
        assert.equal(live.client.state.activeCampaignId.value, CAMPAIGN);
      },
    },
    {
      id: "back to campaigns leaves the forbidden campaign",
      closeCode: 4403,
      button: "connection-back-to-campaigns",
      check: (live) => assert.equal(live.client.state.activeCampaignId.value, null),
    },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const live = liveTable(PLAYER_ID, tableState());
      live.client.state.activeCampaignId.value = CAMPAIGN;
      const ui = mount(h(ConnectionBanner, { client: live.client }));
      live.socket.serverClose(c.closeCode);
      ui.click(c.button);
      c.check(live);
      live.client.disconnect();
      ui.unmount();
    });
  }
});

describe("CommandFeedbackToasts", () => {
  it("rejected_command_toast_matches_correlation_id: the toast names the refused action", () => {
    const live = liveTable(PLAYER_ID, tableState());
    const ui = mount(h(CommandFeedbackToasts, { client: live.client }));
    const region = ui.byTestId("command-feedback");
    assert.equal(region.getAttribute("role"), "log");
    assert.equal(region.getAttribute("aria-live"), "assertive");
    assert.equal(region.getAttribute("aria-relevant"), "additions");
    assert.equal(region.textContent, "", "the live region is mounted before any message");

    live.client.submitCommand(commands.moveToken(HERO, { x: 50, y: 50 }));
    live.client.submitCommand(commands.advanceTurn());
    const moveId = (decode(live.socket.sent[0]) as { SubmitCommand: { correlation_id: string } }).SubmitCommand.correlation_id;
    live.socket.receive({ CommandRejected: { reason: "Not your turn", correlation_id: moveId } });

    const items = ui.container.querySelectorAll('[data-testid="command-feedback-item"]');
    assert.equal(items.length, 1);
    assert.equal(items[0].getAttribute("data-kind"), "rejected");
    assert.match(items[0].textContent, /^Move token was refused: Not your turn/);
    live.client.disconnect();
    ui.unmount();
  });

  const messages: Array<{ id: string; locale: LocaleCode; act: (live: ReturnType<typeof liveTable>) => void; expected: RegExp }> = [
    {
      id: "submit_while_offline_shows_feedback: a command sent while disconnected says it was not sent",
      locale: "en",
      act: (live) => {
        live.client.disconnect();
        live.client.submitCommand(commands.advanceTurn());
      },
      expected: /^Next turn was not sent: you are not connected to the table\./,
    },
    {
      id: "French rejection toast is localized around the server reason",
      locale: "fr",
      act: (live) => {
        live.client.rollDice("1d20", "Public", "");
        live.socket.receive({ CommandRejected: { reason: "invalid expression" } });
      },
      expected: /^Action refusée \(Jet de dés\) : invalid expression/,
    },
    {
      id: "a rejection that matches no action falls back to a generic label",
      locale: "en",
      act: (live) => live.socket.receive({ CommandRejected: { reason: "malformed frame" } }),
      expected: /^Action was refused: malformed frame/,
    },
  ];
  for (const c of messages) {
    it(c.id, () => {
      localeSignal.value = c.locale;
      const live = liveTable(PLAYER_ID, tableState());
      const ui = mount(h(CommandFeedbackToasts, { client: live.client }));
      c.act(live);
      assert.match(ui.byTestId("command-feedback-item").textContent, c.expected);
      live.client.disconnect();
      ui.unmount();
    });
  }

  it("dismiss removes the toast; toasts never disappear on a timer", () => {
    const live = liveTable(PLAYER_ID, tableState());
    const ui = mount(h(CommandFeedbackToasts, { client: live.client }));
    live.socket.receive({ CommandRejected: { reason: "Not your turn" } });
    assert.ok(ui.byTestId("command-feedback-item"));
    ui.click("command-feedback-dismiss");
    assert.equal(ui.byTestId("command-feedback-item"), null);
    live.client.disconnect();
    ui.unmount();
  });
});
