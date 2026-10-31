import { useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { appSignals } from "../state/appSignals.ts";

export interface CompendiumDrawerProps {
  children?: ComponentChildren;
  onClose?: () => void;
}

interface CompendiumEntryItem {
  id: string;
  name: string;
  entityType: "spell" | "item" | "feat" | "monster";
  description: string;
}

const SRD_BASELINE: CompendiumEntryItem[] = [
  { id: "fire-bolt", name: "Fire Bolt", entityType: "spell", description: "Ranged cantrip dealing 1d10 fire damage." },
  { id: "magic-missile", name: "Magic Missile", entityType: "spell", description: "Three glowing darts of force dealing 1d4+1 each." },
  { id: "cure-wounds", name: "Cure Wounds", entityType: "spell", description: "A creature you touch regains 1d8 + mod hit points." },
  { id: "longsword", name: "Longsword", entityType: "item", description: "Versatile martial weapon dealing 1d8 (1d10) slashing." },
  { id: "potion-healing", name: "Potion of Healing", entityType: "item", description: "Magical red draught restoring 2d4+2 HP." },
];

export function CompendiumDrawer(props: CompendiumDrawerProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [filterType, setFilterType] = useState<string>("all");

  const filtered = SRD_BASELINE.filter((item) => {
    const matchQ = item.name.toLowerCase().includes(query.toLowerCase());
    const matchT = filterType === "all" || item.entityType === filterType;
    return matchQ && matchT;
  });

  const handleDragStart = (e: DragEvent, item: CompendiumEntryItem) => {
    const payload = {
      systemId: "dnd5e",
      entityType: item.entityType,
      id: item.id,
      name: item.name,
      data: { name: item.name, description: item.description },
    };
    e.dataTransfer?.setData("application/json", JSON.stringify(payload));
  };

  return (
    <aside
      role="complementary"
      aria-label="Compendium Browser"
      data-testid="compendium-drawer"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        bottom: 0,
        width: "360px",
        maxWidth: "100vw",
        backgroundColor: "var(--atlas-bg)",
        borderRight: "1px solid var(--atlas-surface)",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        boxShadow: "4px 0 16px var(--atlas-surface-raised)",
        color: "var(--atlas-text)",
      }}
    >
      <header style={{ padding: "1rem", borderBottom: "1px solid var(--atlas-surface)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.125rem", color: "var(--atlas-action)" }}>SRD 5.1 Compendium</h2>
          <span style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>Drag spells/items onto Actor Sheet</span>
        </div>
        <button
          type="button"
          data-testid="close-compendium-btn"
          onClick={() => {
            appSignals.activeDrawerSignal.value = null;
            props.onClose?.();
          }}
          style={{ padding: "0.375rem 0.625rem", backgroundColor: "var(--atlas-border)", color: "var(--atlas-text)", border: "none", borderRadius: "4px", cursor: "pointer" }}
        >
          Close
        </button>
      </header>

      <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--atlas-surface)" }}>
        <input
          type="text"
          aria-label="Search SRD compendium"
          placeholder="Search SRD compendium..."
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          data-testid="compendium-search-input"
          style={{ width: "100%", padding: "0.5rem", backgroundColor: "var(--atlas-bg)", border: "1px solid var(--atlas-border)", borderRadius: "4px", color: "var(--atlas-text)", marginBottom: "0.5rem" }}
        />
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {['all', 'spell', 'item'].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setFilterType(t)}
              data-testid={`filter-${t}-btn`}
              style={{
                padding: "0.25rem 0.5rem",
                backgroundColor: filterType === t ? "var(--atlas-info)" : "var(--atlas-surface)",
                color: filterType === t ? "var(--atlas-bg)" : "var(--atlas-text-muted)",
                border: "none",
                borderRadius: "4px",
                fontSize: "0.75rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "1rem" }}>
        {filtered.map((item) => (
          <div
            key={item.id}
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
            data-testid={`compendium-card-${item.id}`}
            style={{
              padding: "0.75rem",
              backgroundColor: "var(--atlas-surface)",
              border: "1px solid var(--atlas-surface)",
              borderRadius: "6px",
              marginBottom: "0.5rem",
              cursor: "grab",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: item.entityType === "spell" ? "var(--atlas-info)" : "var(--atlas-info)" }}>{item.name}</strong>
              <span style={{ fontSize: "0.625rem", padding: "0.125rem 0.375rem", backgroundColor: "var(--atlas-surface)", borderRadius: "4px" }}>
                {item.entityType.toUpperCase()}
              </span>
            </div>
            <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>{item.description}</p>
            <div style={{ marginTop: "0.5rem", display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                aria-label={`Add ${item.name} to Actor Sheet`}
                data-testid={`add-to-sheet-${item.id}-btn`}
                onClick={() => {
                  const actor = appSignals.actorsSignal.value[0];
                  if (!actor) return;
                  const currentActors = [...appSignals.actorsSignal.value];
                  const idx = currentActors.findIndex((a) => a.id === actor.id);
                  if (idx !== -1) {
                    const sheet = (currentActors[idx].sheet as Record<string, unknown>) || {};
                    const items = Array.isArray(sheet.items) ? [...sheet.items] : [];
                    items.push({ id: item.id, name: item.name, entityType: item.entityType, description: item.description });
                    currentActors[idx] = { ...currentActors[idx], sheet: { ...sheet, items } };
                    appSignals.actorsSignal.value = currentActors;
                  }
                }}
                style={{
                  padding: "0.25rem 0.5rem",
                  backgroundColor: "var(--atlas-surface)",
                  color: "var(--atlas-info)",
                  border: "1px solid var(--atlas-info)",
                  borderRadius: "4px",
                  fontSize: "0.75rem",
                  cursor: "pointer",
                }}
              >
                Add to Sheet
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
