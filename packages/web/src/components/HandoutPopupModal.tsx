import { useEffect, useRef } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { appSignals } from "../state/appSignals.ts";
import type { HandoutRevealedBroadcast } from "../types/index.ts";

export interface HandoutPopupModalProps {
  children?: ComponentChildren;
  handout?: HandoutRevealedBroadcast | null;
  onClose?: () => void;
}

export function HandoutPopupModal(props: HandoutPopupModalProps): JSX.Element | null {
  const handout = props.handout ?? appSignals.revealedHandoutSignal.value;
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  const handleClose = () => {
    appSignals.revealedHandoutSignal.value = null;
    props.onClose?.();
  };

  useEffect(() => {
    if (!handout) return;
    closeBtnRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handout]);

  if (!handout) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="handout-popup-title"
      data-testid="handout-popup-modal"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "var(--atlas-surface-raised)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 80,
        padding: "1rem",
      }}
    >
      <div
        style={{
          backgroundColor: "var(--atlas-surface)",
          border: "2px solid var(--atlas-action)",
          borderRadius: "8px",
          maxWidth: "540px",
          width: "100%",
          padding: "1.5rem",
          color: "var(--atlas-text)",
        }}
      >
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 id="handout-popup-title" style={{ margin: 0, fontSize: "1.25rem", color: "var(--atlas-action)" }}>
            {handout.title}
          </h3>
          <span style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>
            Revealed by {handout.revealedBy || "GM"}
          </span>
        </header>

        <div
          data-testid="handout-content-body"
          style={{
            backgroundColor: "var(--atlas-bg)",
            padding: "1rem",
            borderRadius: "4px",
            border: "1px solid var(--atlas-surface)",
            marginBottom: "1.5rem",
            whiteSpace: "pre-wrap",
          }}
        >
          {handout.content}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={handleClose}
            data-testid="close-handout-modal-btn"
            style={{
              padding: "0.5rem 1rem",
              backgroundColor: "var(--atlas-border)",
              color: "var(--atlas-text)",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Close Handout
          </button>
        </div>
      </div>
    </div>
  );
}
