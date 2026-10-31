import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client as defaultClient, type ApiClient } from "../api/client.ts";
import { CharacterBuilderWizard } from "../builder/CharacterBuilderWizard.ts";
import { appSignals } from "../state/appSignals.ts";
import type { AbilityId, BuilderStep } from "../builder/types.ts";
import type { ActorRecord } from "../types/index.ts";

export interface ActorBuilderModalProps {
  children?: ComponentChildren;
  client?: ApiClient;
  campaignId?: string;
  onClose?: () => void;
  onSuccess?: (actor: ActorRecord) => void;
}

export function ActorBuilderModal(props: ActorBuilderModalProps): JSX.Element {
  const activeClient = props.client || defaultClient;
  const activeCampaign = appSignals.activeCampaignSignal.value;
  const campaignId = props.campaignId || activeCampaign?.id || "";

  const [wizard] = useState(() => new CharacterBuilderWizard());
  const [, setRevision] = useState(0);
  const [name, setName] = useState("Valeros");
  const [ancestry, setAncestry] = useState("human");
  const [characterClass, setCharacterClass] = useState("fighter");
  const [scores, setScores] = useState<Record<AbilityId, number>>({
    str: 15,
    dex: 14,
    con: 13,
    int: 12,
    wis: 10,
    cha: 8,
  });
  const [selectedEquipment, setSelectedEquipment] = useState<string[]>(["longsword", "shield"]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const currentStep = wizard.currentStep;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        props.onClose?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props.onClose]);

  const syncDraft = () => {
    wizard.draftStore.initDraft({
      name,
      ancestryId: ancestry,
      classId: characterClass,
      abilityScores: scores,
      equipmentIds: selectedEquipment,
    });
    setRevision((r) => r + 1);
  };

  const handleNext = () => {
    syncDraft();
    wizard.nextStep();
    setRevision((r) => r + 1);
  };

  const handlePrev = () => {
    wizard.previousStep();
    setRevision((r) => r + 1);
  };

  const handleSubmit = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    if (!campaignId) {
      setErrorMessage("Campaign ID is required to spawn actor.");
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      syncDraft();
      const actorId = `actor-${Date.now()}`;
      const newActor: ActorRecord = {
        id: actorId,
        campaignId,
        name: name.trim() || "Hero",
        kind: "character",
        hp: 12,
        maxHp: 12,
        position: { x: 200, y: 200 },
        topLeft: { x: 200, y: 200 },
        elevationFt: 0,
        sheet: {
          name: name.trim() || "Hero",
          ancestryId: ancestry,
          classId: characterClass,
          abilities: {
            str: { score: scores.str, mod: Math.floor((scores.str - 10) / 2) },
            dex: { score: scores.dex, mod: Math.floor((scores.dex - 10) / 2) },
            con: { score: scores.con, mod: Math.floor((scores.con - 10) / 2) },
            int: { score: scores.int, mod: Math.floor((scores.int - 10) / 2) },
            wis: { score: scores.wis, mod: Math.floor((scores.wis - 10) / 2) },
            cha: { score: scores.cha, mod: Math.floor((scores.cha - 10) / 2) },
          },
          items: selectedEquipment.map((id) => ({ id, name: id })),
        },
      };

      await activeClient.updateActor(campaignId, actorId, {
        ...newActor,
        spawnOnMap: true,
      });

      appSignals.actorsSignal.value = [...appSignals.actorsSignal.value, newActor];
      if (appSignals.tableStateSignal.value) {
        const currentTokens = { ...appSignals.tableStateSignal.value.tokens };
        currentTokens[actorId] = {
          id: actorId,
          name: newActor.name,
          topLeft: { x: 200, y: 200 },
          gridW: 1,
          gridH: 1,
          isSqueezing: false,
          elevationFt: 0,
          heightFt: 5,
          visibilityChannel: 1,
          invisible: false,
          hp: 12,
          maxHp: 12,
          tempHp: 0,
          speedMaxFt: 30,
          speedRemainingFt: 30,
          hasAction: true,
          hasBonusAction: true,
          hasReaction: true,
        };
        appSignals.tableStateSignal.value = {
          ...appSignals.tableStateSignal.value,
          tokens: currentTokens,
        };
      }

      props.onSuccess?.(newActor);
      props.onClose?.();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to create character");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="builder-modal-title"
      data-testid="actor-builder-modal"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          props.onClose?.();
        }
      }}
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
        padding: "1rem",
        zIndex: 60,
      }}
    >
      <div
        style={{
          backgroundColor: "var(--atlas-surface)",
          border: "1px solid var(--atlas-border)",
          borderRadius: "8px",
          maxWidth: "540px",
          width: "100%",
          padding: "1.5rem",
          color: "var(--atlas-text)",
        }}
      >
        <header style={{ marginBottom: "1rem", borderBottom: "1px solid var(--atlas-surface)", paddingBottom: "0.75rem" }}>
          <h2 id="builder-modal-title" style={{ margin: 0, fontSize: "1.25rem", color: "var(--atlas-action)" }}>
            5-Step SRD Character Builder ({currentStep})
          </h2>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            {(['ancestry', 'class', 'abilityScores', 'equipment', 'review'] as BuilderStep[]).map((st, i) => (
              <span
                key={st}
                data-testid={`step-indicator-${st}`}
                style={{
                  fontSize: "0.75rem",
                  padding: "0.125rem 0.5rem",
                  borderRadius: "4px",
                  backgroundColor: currentStep === st ? "var(--atlas-action)" : "var(--atlas-surface)",
                  color: currentStep === st ? "var(--atlas-bg)" : "var(--atlas-text-muted)",
                  fontWeight: currentStep === st ? 700 : 400,
                }}
              >
                {i + 1}. {st}
              </span>
            ))}
          </div>
        </header>

        {errorMessage && (
          <div role="alert" style={{ backgroundColor: "var(--atlas-info)", color: "var(--atlas-info)", padding: "0.5rem", borderRadius: "4px", marginBottom: "1rem" }}>
            {errorMessage}
          </div>
        )}

        <div style={{ minHeight: "220px", marginBottom: "1.5rem" }}>
          {currentStep === "ancestry" && (
            <div>
              <label htmlFor="builder-char-name" style={{ display: "block", marginBottom: "0.25rem" }}>Character Name</label>
              <input
                id="builder-char-name"
                type="text"
                value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
                data-testid="builder-name-input"
                style={{ width: "100%", padding: "0.5rem", backgroundColor: "var(--atlas-bg)", border: "1px solid var(--atlas-border)", borderRadius: "4px", color: "var(--atlas-text)", marginBottom: "1rem" }}
              />
              <label htmlFor="builder-ancestry-select" style={{ display: "block", marginBottom: "0.25rem" }}>Ancestry / Species</label>
              <select
                id="builder-ancestry-select"
                value={ancestry}
                onChange={(e) => setAncestry((e.target as HTMLSelectElement).value)}
                data-testid="builder-ancestry-select"
                style={{ width: "100%", padding: "0.5rem", backgroundColor: "var(--atlas-bg)", border: "1px solid var(--atlas-border)", borderRadius: "4px", color: "var(--atlas-text)" }}
              >
                <option value="human">Human</option>
                <option value="elf">Elf</option>
                <option value="dwarf">Dwarf</option>
                <option value="halfling">Halfling</option>
              </select>
            </div>
          )}

          {currentStep === "class" && (
            <div>
              <label htmlFor="builder-class-select" style={{ display: "block", marginBottom: "0.25rem" }}>Class</label>
              <select
                id="builder-class-select"
                value={characterClass}
                onChange={(e) => setCharacterClass((e.target as HTMLSelectElement).value)}
                data-testid="builder-class-select"
                style={{ width: "100%", padding: "0.5rem", backgroundColor: "var(--atlas-bg)", border: "1px solid var(--atlas-border)", borderRadius: "4px", color: "var(--atlas-text)" }}
              >
                <option value="fighter">Fighter</option>
                <option value="wizard">Wizard</option>
                <option value="rogue">Rogue</option>
                <option value="cleric">Cleric</option>
              </select>
            </div>
          )}

          {currentStep === "abilityScores" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem" }}>
              {(['str', 'dex', 'con', 'int', 'wis', 'cha'] as AbilityId[]).map((ab) => (
                <div key={ab}>
                  <label htmlFor={`builder-score-${ab}`} style={{ display: "block", fontSize: "0.75rem", textTransform: "uppercase" }}>{ab}</label>
                  <input
                    id={`builder-score-${ab}`}
                    type="number"
                    value={scores[ab]}
                    onInput={(e) => setScores({ ...scores, [ab]: Number((e.target as HTMLInputElement).value) })}
                    data-testid={`builder-score-${ab}`}
                    style={{ width: "100%", padding: "0.375rem", backgroundColor: "var(--atlas-bg)", border: "1px solid var(--atlas-border)", borderRadius: "4px", color: "var(--atlas-text)" }}
                  />
                </div>
              ))}
            </div>
          )}

          {currentStep === "equipment" && (
            <div>
              <p style={{ fontSize: "0.875rem", color: "var(--atlas-text-muted)" }}>Selected SRD Starting Gear:</p>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {selectedEquipment.map((eq) => (
                  <span key={eq} data-testid={`builder-equip-${eq}`} style={{ padding: "0.25rem 0.5rem", backgroundColor: "var(--atlas-surface)", borderRadius: "4px" }}>
                    {eq}
                  </span>
                ))}
              </div>
            </div>
          )}

          {currentStep === "review" && (
            <div data-testid="builder-review-pane">
              <h4 style={{ margin: "0 0 0.5rem 0", color: "var(--atlas-info)" }}>{name} ({ancestry} {characterClass})</h4>
              <div style={{ fontSize: "0.875rem", color: "var(--atlas-text-muted)" }}>
                STR: {scores.str} | DEX: {scores.dex} | CON: {scores.con} | INT: {scores.int} | WIS: {scores.wis} | CHA: {scores.cha}
              </div>
              <div style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>
                Submitting will persist to PostgreSQL and spawn the token at (200, 200).
              </div>
            </div>
          )}
        </div>

        <footer style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--atlas-surface)", paddingTop: "1rem" }}>
          <button
            type="button"
            onClick={props.onClose}
            style={{ padding: "0.5rem 1rem", backgroundColor: "var(--atlas-border)", color: "var(--atlas-text)", border: "none", borderRadius: "4px", cursor: "pointer" }}
          >
            Cancel
          </button>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {currentStep !== "ancestry" && (
              <button
                type="button"
                onClick={handlePrev}
                data-testid="builder-prev-btn"
                style={{ padding: "0.5rem 1rem", backgroundColor: "var(--atlas-surface)", color: "var(--atlas-text)", border: "1px solid var(--atlas-border)", borderRadius: "4px", cursor: "pointer" }}
              >
                Back
              </button>
            )}
            {currentStep !== "review" ? (
              <button
                type="button"
                onClick={handleNext}
                data-testid="builder-next-btn"
                style={{ padding: "0.5rem 1rem", backgroundColor: "var(--atlas-action)", color: "var(--atlas-bg)", fontWeight: 600, border: "none", borderRadius: "4px", cursor: "pointer" }}
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                disabled={loading}
                onClick={handleSubmit}
                data-testid="builder-submit-btn"
                style={{ padding: "0.5rem 1rem", backgroundColor: "var(--atlas-success)", color: "var(--atlas-bg)", fontWeight: 600, border: "none", borderRadius: "4px", cursor: "pointer" }}
              >
                {loading ? "Spawning..." : "Submit Character"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
