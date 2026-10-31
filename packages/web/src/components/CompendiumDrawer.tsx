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
        backgroundColor: "#0b0f19",
        borderRight: "1px solid #1e293b",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        boxShadow: "4px 0 16px rgba(0,0,0,0.5)",
        color: "#f8fafc",
      }}
    >
      <header style={{ padding: "1rem", borderBottom: "1px solid #1e293b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.125rem", color: "#f59e0b" }}>SRD 5.1 Compendium</h2>
          <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Drag spells/items onto Actor Sheet</span>
        </div>
        <button
          type="button"
          data-testid="close-compendium-btn"
          onClick={() => {
            appSignals.activeDrawerSignal.value = null;
            props.onClose?.();
          }}
          style={{ padding: "0.375rem 0.625rem", backgroundColor: "#334155", color: "#f8fafc", border: "none", borderRadius: "4px", cursor: "pointer" }}
        >
          Close
        </button>
      </header>

      <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid #1e293b" }}>
        <input
          type="text"
          aria-label="Search SRD compendium"
          placeholder="Search SRD compendium..."
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          data-testid="compendium-search-input"
          style={{ width: "100%", padding: "0.5rem", backgroundColor: "#0f172a", border: "1px solid #334155", borderRadius: "4px", color: "#f8fafc", marginBottom: "0.5rem" }}
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
                backgroundColor: filterType === t ? "#38bdf8" : "#1e293b",
                color: filterType === t ? "#0f172a" : "#cbd5e1",
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
              backgroundColor: "#131a2a",
              border: "1px solid #1e293b",
              borderRadius: "6px",
              marginBottom: "0.5rem",
              cursor: "grab",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: item.entityType === "spell" ? "#c084fc" : "#38bdf8" }}>{item.name}</strong>
              <span style={{ fontSize: "0.625rem", padding: "0.125rem 0.375rem", backgroundColor: "#1e293b", borderRadius: "4px" }}>
                {item.entityType.toUpperCase()}
              </span>
            </div>
            <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.75rem", color: "#94a3b8" }}>{item.description}</p>
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
                  backgroundColor: "#1e293b",
                  color: "#38bdf8",
                  border: "1px solid #0284c7",
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
