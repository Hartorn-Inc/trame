import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client as defaultClient, type ApiClient } from "../api/client.ts";

export interface OpportunityReactionPrompt {
  id: string;
  triggerTokenName: string;
  reactorTokenName: string;
  description: string;
}

export interface ReactionBannerProps {
  children?: ComponentChildren;
  client?: ApiClient;
  prompt?: OpportunityReactionPrompt | null;
  durationSeconds?: number;
  onDecision?: (accepted: boolean) => void;
}

export function ReactionBanner(props: ReactionBannerProps): JSX.Element | null {
  const activeClient = props.client || defaultClient;
  const prompt = props.prompt;
  const totalDuration = props.durationSeconds || 5;

  const [secondsRemaining, setSecondsRemaining] = useState(totalDuration);
  const reactBtnRef = useRef<HTMLButtonElement | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const decidedRef = useRef(false);

  const clearTimer = () => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const handleDecision = (accepted: boolean) => {
    if (!prompt || decidedRef.current) return;
    decidedRef.current = true;
    clearTimer();
    activeClient.sendCommand({
      cmd: "DECIDE_REACTION",
      prompt_id: prompt.id,
      accepted,
    });
    props.onDecision?.(accepted);
  };

  useEffect(() => {
    clearTimer();
    if (!prompt) return;
    decidedRef.current = false;
    let remaining = totalDuration;
    setSecondsRemaining(remaining);
    intervalRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        setSecondsRemaining(0);
        handleDecision(false);
      } else {
        setSecondsRemaining(remaining);
      }
    }, 1000);

    return () => clearTimer();
  }, [prompt]);

  useEffect(() => {
    if (prompt && reactBtnRef.current) {
      reactBtnRef.current.focus();
    }
  }, [prompt]);

  if (!prompt) {
    return null;
  }

  return (
    <div
      data-testid="reaction-banner"
      style={{
        position: "fixed",
        top: "1rem",
        left: "50%",
        transform: "translateX(-50%)",
        backgroundColor: "var(--atlas-action)",
        border: "2px solid var(--atlas-action)",
        borderRadius: "8px",
        padding: "0.875rem 1.25rem",
        color: "var(--atlas-on-action)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        boxShadow: "0 10px 25px var(--atlas-surface-raised)",
      }}
    >
      <div role="alert" aria-live="assertive" aria-atomic="true">
        <strong style={{ display: "block", fontSize: "0.875rem" }}>Opportunity Reaction Available!</strong>
        <span style={{ fontSize: "0.75rem", color: "var(--atlas-on-action)" }}>
          {prompt.triggerTokenName} provoked a reaction from {prompt.reactorTokenName} ({prompt.description})
        </span>
      </div>

      <div
        aria-hidden="true"
        data-testid="reaction-timer-value"
        style={{
          fontSize: "1.25rem",
          fontWeight: 700,
          color: "var(--atlas-text)",
          padding: "0.25rem 0.5rem",
          backgroundColor: "var(--atlas-surface)",
          borderRadius: "4px",
        }}
      >
        {secondsRemaining}s
      </div>

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          ref={reactBtnRef}
          type="button"
          aria-label="React"
          data-testid="accept-reaction-btn"
          onClick={() => handleDecision(true)}
          style={{
            minHeight: "40px",
            minWidth: "40px",
            padding: "0.375rem 0.75rem",
            backgroundColor: "var(--atlas-surface)",
            color: "var(--atlas-text)",
            fontWeight: 600,
            border: "1px solid var(--atlas-border)",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          React
        </button>
        <button
          type="button"
          aria-label="Pass"
          data-testid="decline-reaction-btn"
          onClick={() => handleDecision(false)}
          style={{
            minHeight: "40px",
            minWidth: "40px",
            padding: "0.375rem 0.75rem",
            backgroundColor: "transparent",
            color: "var(--atlas-on-action)",
            border: "1px solid var(--atlas-on-action)",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Pass
        </button>
      </div>
    </div>
  );
}
