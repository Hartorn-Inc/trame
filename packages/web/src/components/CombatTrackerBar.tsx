import { useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client as defaultClient, type ApiClient } from "../api/client.ts";
import { appSignals } from "../state/appSignals.ts";
import { ReactionBanner, type OpportunityReactionPrompt } from "./ReactionBanner.tsx";

export interface CombatTrackerBarProps {
  children?: ComponentChildren;
  client?: ApiClient;
}

export function CombatTrackerBar(props: CombatTrackerBarProps): JSX.Element | null {
  const activeClient = props.client || defaultClient;
  const roomState = appSignals.tableStateSignal.value;
  const [activeReactionPrompt, setActiveReactionPrompt] = useState<OpportunityReactionPrompt | null>(null);

  if (!roomState || roomState.mode !== "TURN_BY_TURN") {
    return null;
  }

  const initiativeOrder = roomState.initiativeOrder || [];
  const activeTurnIndex = roomState.activeTurnIndex || 0;
  const round = roomState.round || 1;

  const handleNextTurn = () => {
    activeClient.sendCommand({ cmd: "ADVANCE_TURN" });
    const nextIdx = (activeTurnIndex + 1) % (initiativeOrder.length || 1);
    const nextRound = nextIdx === 0 ? round + 1 : round;
    appSignals.tableStateSignal.value = {
      ...roomState,
      activeTurnIndex: nextIdx,
      round: nextRound,
    };
  };

  const handleTriggerTestReaction = () => {
    setActiveReactionPrompt({
      id: `prompt-${Date.now()}`,
      triggerTokenName: "Goblin 1",
      reactorTokenName: "Fighter",
      description: "Movement out of reach",
    });
  };

  return (
    <nav
      aria-label="Combat Initiative Tracker"
      data-testid="combat-tracker-bar"
      style={{
        backgroundColor: "var(--atlas-bg)",
        borderBottom: "1px solid var(--atlas-surface)",
        padding: "0.5rem 1rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        color: "var(--atlas-text)",
      }}
    >
      <ReactionBanner prompt={activeReactionPrompt} onDecision={() => setActiveReactionPrompt(null)} />

      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <span data-testid="combat-round-indicator" style={{ fontWeight: 700, color: "var(--atlas-action)", fontSize: "0.875rem" }}>
          Round {round}
        </span>

        <div role="list" aria-label="Initiative Order" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {initiativeOrder.map((tokenId, idx) => {
            const isCurrent = idx === activeTurnIndex;
            const token = roomState.tokens?.[tokenId];
            const label = token?.name || tokenId.slice(0, 6);
            return (
              <div
                key={tokenId}
                role="listitem"
                aria-current={isCurrent ? "true" : undefined}
                aria-label={`${idx + 1}. ${label}${isCurrent ? " (Active turn)" : ""}`}
                data-testid={`initiative-token-${tokenId}`}
                data-active-turn={String(isCurrent)}
                style={{
                  padding: "0.25rem 0.5rem",
                  borderRadius: "4px",
                  backgroundColor: isCurrent ? "var(--atlas-action)" : "var(--atlas-surface)",
                  color: isCurrent ? "var(--atlas-bg)" : "var(--atlas-text-muted)",
                  fontWeight: isCurrent ? 700 : 400,
                  fontSize: "0.75rem",
                  border: isCurrent ? "2px solid var(--atlas-text)" : "1px solid var(--atlas-border)",
                }}
              >
                {idx + 1}. {label}
              </div>
            );
          })}
        </div>
        <span role="status" aria-live="polite" style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>
          Active turn: {roomState.tokens?.[initiativeOrder[activeTurnIndex]]?.name || initiativeOrder[activeTurnIndex] || "None"}
        </span>
      </div>

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          data-testid="trigger-reaction-test-btn"
          onClick={handleTriggerTestReaction}
          style={{
            padding: "0.25rem 0.5rem",
            backgroundColor: "var(--atlas-action)",
            color: "var(--atlas-text)",
            border: "1px solid var(--atlas-action)",
            borderRadius: "4px",
            fontSize: "0.75rem",
            cursor: "pointer",
          }}
        >
          Test Reaction
        </button>
        <button
          type="button"
          data-testid="advance-turn-btn"
          onClick={handleNextTurn}
          style={{
            padding: "0.25rem 0.75rem",
            backgroundColor: "var(--atlas-info)",
            color: "var(--atlas-text)",
            fontWeight: 600,
            border: "none",
            borderRadius: "4px",
            fontSize: "0.75rem",
            cursor: "pointer",
          }}
        >
          Next Turn
        </button>
      </div>
    </nav>
  );
}
