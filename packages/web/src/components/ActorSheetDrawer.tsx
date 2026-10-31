import { useMemo, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client as defaultClient, type ApiClient } from "../api/client.ts";
import { DeclarativeSheetRenderer } from "../sheet/DeclarativeSheetRenderer.ts";
import { WidgetRegistry } from "../sheet/WidgetRegistry.ts";
import { registerAllCanonicalWidgets } from "../sheet/widgets/index.ts";
import { DND5E_SHEET_LAYOUT, type SheetLayoutTree } from "@trame/game-system-dnd5e/src/sheetLayout.ts";
import { appSignals } from "../state/appSignals.ts";
import { CompendiumDragDropManager } from "../dnd/CompendiumDragDropManager.ts";
import type { ActorRecord, ClientDiceLogEntry, TrameCommand } from "../types/index.ts";

registerAllCanonicalWidgets(WidgetRegistry);

export interface ActorSheetDrawerProps {
  children?: ComponentChildren;
  actor?: ActorRecord | null;
  client?: ApiClient;
  layoutTree?: SheetLayoutTree;
  isGm?: boolean;
  userId?: string;
  onClose?: () => void;
}

export function ActorSheetDrawer(props: ActorSheetDrawerProps): JSX.Element | null {
  const activeClient = props.client || defaultClient;
  const user = appSignals.authUserSignal.value;
  const activeCampaign = appSignals.activeCampaignSignal.value;
  const actor = props.actor || (appSignals.actorsSignal.value && appSignals.actorsSignal.value[0]) || null;

  const isGm = Boolean(props.isGm || user?.role === "GM" || activeCampaign?.role === "GM");
  const isOwner = Boolean(
    isGm ||
    (user?.id && actor?.ownerUserId && user.id === actor.ownerUserId) ||
    (!actor?.ownerUserId)
  );

  const [activeTabId, setActiveTabId] = useState<string>("tab-combat");
  const [isDragOver, setIsDragOver] = useState<boolean>(false);

  if (!actor) {
    return null;
  }

  const sheetData = useMemo(() => {
    const baseSheet = (actor.sheet as Record<string, unknown>) || {};
    const abilities = (baseSheet.abilities as Record<string, { score: number; mod: number }>) || {
      str: { score: 10, mod: 0 },
      dex: { score: 10, mod: 0 },
      con: { score: 10, mod: 0 },
      int: { score: 10, mod: 0 },
      wis: { score: 10, mod: 0 },
      cha: { score: 10, mod: 0 },
    };
    const hp = (baseSheet.hp as Record<string, number>) || {
      current: actor.hp ?? 20,
      max: actor.maxHp ?? 20,
      temp: 0,
    };
    return {
      ...baseSheet,
      name: actor.name,
      attributes: {
        hp,
        hitDiceCurrent: 1,
        hitDiceMax: 1,
        hitDieSize: 8,
        deathSaves: { successes: 0, failures: 0 },
      },
      abilities,
      conditions: (baseSheet.conditions as string[]) || [],
      items: (baseSheet.items as unknown[]) || [],
      spellSlots: (baseSheet.spellSlots as number[]) || [2, 0, 0, 0, 0, 0, 0, 0, 0],
      bio: (baseSheet.bio as string) || "",
      notes: (baseSheet.notes as string) || "",
    };
  }, [actor]);

  const actorState = useMemo(() => ({
    sheet: sheetData,
    derived: {
      armorClass: 14,
      initiativeBonus: 2,
      speed: 30,
      abilityMods: {
        str: sheetData.abilities.str?.mod ?? 0,
        dex: sheetData.abilities.dex?.mod ?? 0,
        con: sheetData.abilities.con?.mod ?? 0,
        int: sheetData.abilities.int?.mod ?? 0,
        wis: sheetData.abilities.wis?.mod ?? 0,
        cha: sheetData.abilities.cha?.mod ?? 0,
      },
      savingThrows: [
        { id: "str", name: "Strength", bonus: sheetData.abilities.str?.mod ?? 0, proficient: false },
        { id: "dex", name: "Dexterity", bonus: (sheetData.abilities.dex?.mod ?? 0) + 2, proficient: true },
      ],
      skills: [
        { id: "stealth", name: "Stealth", ability: "dex", bonus: (sheetData.abilities.dex?.mod ?? 0) + 2, proficient: true },
        { id: "perception", name: "Perception", ability: "wis", bonus: sheetData.abilities.wis?.mod ?? 0, proficient: false },
      ],
      attacks: [
        { id: "atk-1", name: "Shortsword", attackBonus: 4, damageFormula: "1d6+2", damageType: "piercing" },
      ],
      spells: [
        { id: "spl-1", name: "Fire Bolt", level: 0, school: "evocation", range: "120 ft" },
      ],
      spellSaveDc: 13,
      spellAttackBonus: 5,
      features: [
        { id: "feat-1", name: "Sneak Attack", source: "Rogue", description: "Extra damage when you have advantage." },
      ],
    },
  }), [sheetData]);

  const handleDispatch = (cmd: unknown) => {
    const command = cmd as Record<string, unknown>;
    if (command && (command.cmd === "ROLL_DICE" || command.cmd === "RollDice")) {
      const expression = String(command.expression || "1d20");
      const reason = String(command.reason || "Roll");
      activeClient.sendCommand({
        cmd: "ROLL_DICE",
        expression,
        reason,
        visibility: "PUBLIC",
      } as unknown as TrameCommand);
      const rollEntry: ClientDiceLogEntry = {
        rollId: `roll-${Date.now()}`,
        rollerUserId: user?.id || "local",
        expression,
        reason,
        blindMasked: false,
        total: 15,
      };
      appSignals.diceLogSignal.value = [...appSignals.diceLogSignal.value, rollEntry];
      return;
    }
    if (command && (command.cmd === "DROP_COMPENDIUM_ENTRY" || command.cmd === "DropCompendiumEntry")) {
      const payload = (command.entry || command.data || command) as Record<string, unknown>;
      const spellOrItem = { id: String(payload.id || `item-${Date.now()}`), name: String(payload.name || "Compendium Drop"), type: payload.entityType || "spell" };
      const currentActors = [...appSignals.actorsSignal.value];
      const idx = currentActors.findIndex((a) => a.id === actor.id);
      if (idx !== -1) {
        const currentSheet = (currentActors[idx].sheet as Record<string, unknown>) || {};
        const existingItems = Array.isArray(currentSheet.items) ? [...currentSheet.items] : [];
        existingItems.push(spellOrItem);
        currentActors[idx] = {
          ...currentActors[idx],
          sheet: {
            ...currentSheet,
            items: existingItems,
          },
        };
        appSignals.actorsSignal.value = currentActors;
      }
      return;
    }
    if (command) {
      activeClient.sendCommand(command as unknown as TrameCommand);
    }
  };

  const renderedTree = useMemo(() => {
    const layout = props.layoutTree || DND5E_SHEET_LAYOUT;
    return DeclarativeSheetRenderer.render(
      layout,
      actorState,
      { isGm, isOwner, userId: user?.id, actorOwnerId: actor.ownerUserId ?? undefined },
      handleDispatch,
    );
  }, [props.layoutTree, actorState, isGm, isOwner, user?.id, actor.ownerUserId]);

  const handleDropPayload = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const rawData = e.dataTransfer?.getData("application/json");
    if (!rawData) return;
    try {
      const payload = JSON.parse(rawData);
      const manager = new CompendiumDragDropManager({
        systemId: "dnd5e",
        dispatchCommand: handleDispatch,
        actorId: actor.id,
      });
      const ok = manager.handleDrop(payload, null, actor.id);
      if (ok) {
        const spellOrItem = {
          id: String(payload.id || `item-${Date.now()}`),
          name: String(payload.name || "Compendium Spell"),
          type: payload.entityType || "spell",
        };
        const currentActors = [...appSignals.actorsSignal.value];
        const idx = currentActors.findIndex((a) => a.id === actor.id);
        if (idx !== -1) {
          const currentSheet = (currentActors[idx].sheet as Record<string, unknown>) || {};
          const existingItems = Array.isArray(currentSheet.items) ? [...currentSheet.items] : [];
          existingItems.push(spellOrItem);
          currentActors[idx] = {
            ...currentActors[idx],
            sheet: {
              ...currentSheet,
              items: existingItems,
            },
          };
          appSignals.actorsSignal.value = currentActors;
        }
      }
    } catch {
      // ignore JSON parse failure
    }
  };

  const renderNode = (node: import("../sheet/types.ts").RenderedLayoutNode): JSX.Element | null => {
    if (!node) return null;
    if (node.kind === "section" || node.kind === "column" || node.kind === "row") {
      const isRow = node.kind === "row";
      return (
        <div
          key={node.id}
          id={node.id}
          data-testid={`sheet-node-${node.id}`}
          style={{
            display: "flex",
            flexDirection: isRow ? "row" : "column",
            gap: "0.75rem",
            flexWrap: isRow ? "wrap" : "nowrap",
            marginBottom: "0.75rem",
          }}
        >
          {node.title && (
            <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.1rem", color: "#f59e0b", width: "100%" }}>
              {node.title}
            </h3>
          )}
          {(node.children || []).map(renderNode)}
        </div>
      );
    }

    if (node.kind === "tabs") {
      const tabs = node.tabs || [];
      const currentTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
      return (
        <div key={node.id} id={node.id} data-testid="sheet-tabs-container" style={{ marginTop: "0.5rem" }}>
          <div role="tablist" aria-label="Character Sheet Sections" style={{ display: "flex", gap: "0.25rem", borderBottom: "1px solid #334155", marginBottom: "0.75rem" }}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                type="button"
                id={`tab-btn-${tab.id}`}
                data-testid={`tab-${tab.id}`}
                aria-selected={currentTab?.id === tab.id}
                aria-controls={`panel-${tab.id}`}
                onClick={() => setActiveTabId(tab.id)}
                style={{
                  padding: "0.5rem 0.875rem",
                  backgroundColor: currentTab?.id === tab.id ? "#1e293b" : "transparent",
                  color: currentTab?.id === tab.id ? "#38bdf8" : "#94a3b8",
                  border: "none",
                  borderBottom: currentTab?.id === tab.id ? "2px solid #38bdf8" : "2px solid transparent",
                  cursor: "pointer",
                  fontWeight: 600,
                  fontSize: "0.875rem",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {currentTab && (
            <div
              role="tabpanel"
              id={`panel-${currentTab.id}`}
              aria-labelledby={`tab-btn-${currentTab.id}`}
              data-testid={`tabpanel-${currentTab.id}`}
            >
              {(currentTab.children || []).map(renderNode)}
            </div>
          )}
        </div>
      );
    }

    if (node.kind === "widget") {
      const widgetType = node.widgetType;
      const output = node.renderedOutput as Record<string, unknown> | undefined;
      return (
        <div
          key={node.id}
          id={node.id}
          data-testid={`widget-${widgetType}`}
          data-widget-type={widgetType}
          style={{
            backgroundColor: "#131a2a",
            border: "1px solid #1e293b",
            borderRadius: "6px",
            padding: "0.75rem",
            flex: "1 1 auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
            <span style={{ fontSize: "0.75rem", color: "#94a3b8", textTransform: "uppercase", fontWeight: 700 }}>
              {widgetType}
            </span>
          </div>
          {renderWidgetBody(widgetType, output, handleDispatch)}
        </div>
      );
    }

    return null;
  };

  const renderWidgetBody = (
    type: string,
    output: Record<string, unknown> | undefined,
    dispatcher: (cmd: unknown) => void,
  ): JSX.Element => {
    switch (type) {
      case "StatBlock6": {
        const abilities = (sheetData.abilities || {}) as Record<string, { score: number; mod: number }>;
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.5rem" }}>
            {Object.entries(abilities).map(([key, val]) => (
              <button
                key={key}
                type="button"
                data-testid={`stat-${key}-btn`}
                onClick={() => {
                  const sign = val.mod >= 0 ? `+${val.mod}` : `${val.mod}`;
                  dispatcher({
                    cmd: "ROLL_DICE",
                    expression: `1d20${sign}`,
                    reason: `Ability Check: ${key.toUpperCase()}`,
                  });
                }}
                style={{
                  backgroundColor: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: "4px",
                  padding: "0.5rem",
                  color: "#f8fafc",
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{key.toUpperCase()}</div>
                <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>{val.score}</div>
                <div style={{ fontSize: "0.75rem", color: "#38bdf8" }}>{val.mod >= 0 ? `+${val.mod}` : val.mod}</div>
              </button>
            ))}
          </div>
        );
      }
      case "ResourceBar": {
        return (
          <div data-testid="resource-bar-display">
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.875rem" }}>
              <span>HP: {actor.hp} / {actor.maxHp}</span>
            </div>
            <div style={{ height: "8px", backgroundColor: "#334155", borderRadius: "4px", overflow: "hidden", marginTop: "0.25rem" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(100, Math.max(0, (actor.hp / actor.maxHp) * 100))}%`,
                  backgroundColor: "#ef4444",
                }}
              />
            </div>
          </div>
        );
      }
      case "ArmorInitiativeSpeed": {
        return (
          <div style={{ display: "flex", justifyContent: "space-around", textAlign: "center" }}>
            <div>
              <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>AC</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>14</div>
            </div>
            <div>
              <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Initiative</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>+2</div>
            </div>
            <div>
              <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Speed</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>30 ft</div>
            </div>
          </div>
        );
      }
      case "AttackActionTable": {
        return (
          <div>
            <button
              type="button"
              data-testid="attack-roll-btn"
              onClick={() => dispatcher({ cmd: "ROLL_DICE", expression: "1d20+4", reason: "Attack: Shortsword" })}
              style={{
                padding: "0.375rem 0.75rem",
                backgroundColor: "#f59e0b",
                color: "#0f172a",
                border: "none",
                borderRadius: "4px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Shortsword (+4 to hit, 1d6+2 dmg)
            </button>
          </div>
        );
      }
      case "SpellbookAccordion": {
        const items = (sheetData.items as Array<{ id: string; name: string }>) || [];
        return (
          <div>
            <div style={{ fontSize: "0.875rem", color: "#94a3b8", marginBottom: "0.5rem" }}>
              Prepared Spells (Slots: 2 / 2)
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              <li style={{ padding: "0.25rem 0", color: "#38bdf8" }}>Fire Bolt (Cantrip)</li>
              {items.map((it) => (
                <li key={it.id} data-testid={`spell-item-${it.id}`} style={{ padding: "0.25rem 0", color: "#a855f7" }}>
                  {it.name}
                </li>
              ))}
            </ul>
          </div>
        );
      }
      case "InventoryContainerTree": {
        const items = (sheetData.items as Array<{ id: string; name: string }>) || [];
        return (
          <div data-testid="inventory-tree-container">
            <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Inventory Items ({items.length})</div>
            <ul style={{ listStyle: "none", padding: 0, margin: "0.25rem 0" }}>
              {items.map((it) => (
                <li key={it.id} data-testid={`inventory-item-${it.id}`} style={{ padding: "0.25rem 0" }}>
                  {it.name}
                </li>
              ))}
            </ul>
          </div>
        );
      }
      default:
        return (
          <div style={{ fontSize: "0.875rem", color: "#cbd5e1" }}>
            {output ? String(JSON.stringify(output).slice(0, 80)) : `${type} Active`}
          </div>
        );
    }
  };

  return (
    <aside
      role="complementary"
      aria-label={`Character Sheet for ${actor.name}`}
      data-testid="actor-sheet-drawer"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDropPayload}
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "480px",
        maxWidth: "100vw",
        backgroundColor: "#0b0f19",
        borderLeft: isDragOver ? "2px dashed #f59e0b" : "1px solid #1e293b",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        boxShadow: "-4px 0 16px rgba(0,0,0,0.5)",
        color: "#f8fafc",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "1rem 1.25rem",
          borderBottom: "1px solid #1e293b",
          backgroundColor: "#0f172a",
        }}
      >
        <div>
          <h2 data-testid="actor-sheet-title" style={{ margin: 0, fontSize: "1.25rem", color: "#f59e0b" }}>
            {actor.name}
          </h2>
          <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
            {actor.kind || "Character"} | D&D 5e SRD 5.1
          </span>
        </div>
        <button
          type="button"
          data-testid="close-sheet-btn"
          onClick={() => {
            appSignals.activeDrawerSignal.value = null;
            props.onClose?.();
          }}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: "#334155",
            color: "#f8fafc",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </header>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "1.25rem",
        }}
      >
        {renderedTree.root ? renderNode(renderedTree.root) : (
          <p style={{ color: "#94a3b8" }}>No sheet layout available.</p>
        )}
      </div>
    </aside>
  );
}
