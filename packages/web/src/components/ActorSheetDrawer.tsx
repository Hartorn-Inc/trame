import { useMemo, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client as defaultClient, type ApiClient } from "../api/client.ts";
import { DeclarativeSheetRenderer } from "../sheet/DeclarativeSheetRenderer.ts";
import { WidgetRegistry } from "../sheet/WidgetRegistry.ts";
import { registerAllCanonicalWidgets } from "../sheet/widgets/index.ts";
import { DND5E_SHEET_LAYOUT, type SheetLayoutTree } from "@trame/game-system-dnd5e";
import { PadlockLockedIcon, PadlockUnlockedIcon } from "./icons/AtlasIcons.tsx";
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
  embedded?: boolean;
  onClose?: () => void;
  onOpenBuilder?: () => void;
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
  const [isPadlockUnlocked, setIsPadlockUnlocked] = useState<boolean>(false);

  if (!actor) {
    return (
      <aside
        role="complementary"
        aria-label="Character Sheet"
        data-testid="actor-sheet-drawer"
        style={{
          position: props.embedded ? "relative" : "fixed",
          top: props.embedded ? undefined : 0,
          right: props.embedded ? undefined : 0,
          bottom: props.embedded ? undefined : 0,
          width: props.embedded ? "100%" : "440px",
          height: props.embedded ? "100%" : undefined,
          maxWidth: "100vw",
          backgroundColor: "var(--atlas-bg)",
          borderLeft: props.embedded ? "none" : "1px solid var(--atlas-surface)",
          zIndex: props.embedded ? 1 : 50,
          display: "flex",
          flexDirection: "column",
          boxShadow: props.embedded ? "none" : "-4px 0 16px var(--atlas-surface-raised)",
          color: "var(--atlas-text)",
          padding: "1.5rem",
        }}
      >
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
          <h2 style={{ margin: 0, fontSize: "1.25rem", color: "var(--atlas-action)" }}>Character Sheet</h2>
          <button
            type="button"
            data-testid="close-sheet-btn"
            onClick={() => {
              appSignals.activeDrawerSignal.value = null;
              props.onClose?.();
            }}
            style={{ padding: "0.375rem 0.625rem", backgroundColor: "var(--atlas-border)", color: "var(--atlas-text)", border: "none", borderRadius: "4px", cursor: "pointer" }}
          >
            Close
          </button>
        </header>
        <div data-testid="sheet-empty-state" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: "1rem" }}>
          <p style={{ color: "var(--atlas-text-muted)", margin: 0 }}>No character selected or created yet.</p>
          <button
            type="button"
            data-testid="empty-state-open-builder-btn"
            onClick={() => {
              appSignals.activeDrawerSignal.value = null;
              props.onClose?.();
              props.onOpenBuilder?.();
            }}
            style={{
              padding: "0.5rem 1rem",
              backgroundColor: "var(--atlas-action)",
              color: "var(--atlas-bg)",
              fontWeight: 600,
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Create New Character
          </button>
        </div>
      </aside>
    );
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
      savingThrows: {
        str: { modifier: sheetData.abilities.str?.mod ?? 0, proficient: false },
        dex: { modifier: (sheetData.abilities.dex?.mod ?? 0) + 2, proficient: true },
        con: { modifier: sheetData.abilities.con?.mod ?? 0, proficient: false },
        int: { modifier: sheetData.abilities.int?.mod ?? 0, proficient: false },
        wis: { modifier: sheetData.abilities.wis?.mod ?? 0, proficient: false },
        cha: { modifier: sheetData.abilities.cha?.mod ?? 0, proficient: false },
      },
      skills: {
        acrobatics: { modifier: sheetData.abilities.dex?.mod ?? 0, proficiencyLevel: "none", passive: 10 },
        athletics: { modifier: sheetData.abilities.str?.mod ?? 0, proficiencyLevel: "none", passive: 10 },
        stealth: { modifier: (sheetData.abilities.dex?.mod ?? 0) + 2, proficiencyLevel: "proficient", passive: 12 },
        perception: { modifier: sheetData.abilities.wis?.mod ?? 0, proficiencyLevel: "none", passive: 10 },
      },
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
    if (command && (command.cmd === "ROLL_DICE" || command.cmd === "RollDice" || command.type === "ROLL_DICE" || command.type === "RollDice")) {
      const expression = String(command.expression || command.formula || "1d20");
      const reason = String(command.reason || command.label || "Roll");
      activeClient.sendCommand({
        cmd: "ROLL_DICE",
        expression,
        reason,
        visibility: "PUBLIC",
      } as unknown as TrameCommand);
      const entry: ClientDiceLogEntry = {
        rollId: `roll-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        rollerUserId: user?.id || "player",
        expression,
        reason,
        blindMasked: false,
        total: Math.floor(Math.random() * 20) + 1,
      };
      appSignals.diceLogSignal.value = [...appSignals.diceLogSignal.value, entry];
      return;
    }
    if (
      command &&
      (command.cmd === "DROP_COMPENDIUM_ENTRY" ||
        command.cmd === "DropCompendiumEntry" ||
        command.type === "DROP_COMPENDIUM_ENTRY" ||
        command.type === "DropCompendiumEntry")
    ) {
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
      {
        isGm,
        isOwner,
        userId: user?.id,
        actorOwnerId: actor.ownerUserId ?? undefined,
        padlockUnlocked: isPadlockUnlocked,
      },
      handleDispatch,
    );
  }, [props.layoutTree, actorState, isGm, isOwner, user?.id, actor.ownerUserId, isPadlockUnlocked]);

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
      manager.handleDrop(payload, null, actor.id);
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
            <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.1rem", color: "var(--atlas-action)", width: "100%" }}>
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
          <div role="tablist" aria-label="Character Sheet Sections" style={{ display: "flex", gap: "0.25rem", borderBottom: "1px solid var(--atlas-border)", marginBottom: "0.75rem" }}>
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
                  backgroundColor: currentTab?.id === tab.id ? "var(--atlas-surface)" : "transparent",
                  color: currentTab?.id === tab.id ? "var(--atlas-info)" : "var(--atlas-text-muted)",
                  border: "none",
                  borderBottom: currentTab?.id === tab.id ? "2px solid var(--atlas-info)" : "2px solid transparent",
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
            backgroundColor: "var(--atlas-surface)",
            border: "1px solid var(--atlas-surface)",
            borderRadius: "6px",
            padding: "0.75rem",
            flex: "1 1 auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)", textTransform: "uppercase", fontWeight: 700 }}>
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
                  backgroundColor: "var(--atlas-bg)",
                  border: "1px solid var(--atlas-border)",
                  borderRadius: "4px",
                  padding: "0.5rem",
                  color: "var(--atlas-text)",
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>{key.toUpperCase()}</div>
                <div className="atlas-tabular-nums" style={{ fontSize: "1.25rem", fontWeight: 700 }}>{val.score}</div>
                <div className="atlas-tabular-nums" style={{ fontSize: "0.75rem", color: "var(--atlas-action)" }}>{val.mod >= 0 ? `+${val.mod}` : val.mod}</div>
              </button>
            ))}
          </div>
        );
      }
      case "ResourceBar": {
        return (
          <div data-testid="resource-bar-display">
            <div className="atlas-tabular-nums" style={{ display: "flex", justifyContent: "space-between", fontSize: "0.875rem" }}>
              <span>HP: {actor.hp} / {actor.maxHp}</span>
            </div>
            <div style={{ height: "8px", backgroundColor: "var(--atlas-border)", borderRadius: "4px", overflow: "hidden", marginTop: "0.25rem" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(100, Math.max(0, (actor.hp / actor.maxHp) * 100))}%`,
                  backgroundColor: "var(--atlas-danger)",
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
              <div style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>AC</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>14</div>
            </div>
            <div>
              <div style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>Initiative</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>+2</div>
            </div>
            <div>
              <div style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>Speed</div>
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
                backgroundColor: "var(--atlas-action)",
                color: "var(--atlas-bg)",
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
        const items = (sheetData.items as Array<{ id: string; name: string; type?: string; entityType?: string }>) || [];
        const spells = items.filter((it) => it.type === "spell" || it.entityType === "spell");
        return (
          <div>
            <div style={{ fontSize: "0.875rem", color: "var(--atlas-text-muted)", marginBottom: "0.5rem" }}>
              Prepared Spells (Slots: 2 / 2)
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              <li style={{ padding: "0.25rem 0", color: "var(--atlas-info)" }}>Fire Bolt (Cantrip)</li>
              {spells.map((it) => (
                <li key={it.id} data-testid={`spell-item-${it.id}`} style={{ padding: "0.25rem 0", color: "var(--atlas-info)" }}>
                  {it.name}
                </li>
              ))}
            </ul>
          </div>
        );
      }
      case "InventoryContainerTree": {
        const items = (sheetData.items as Array<{ id: string; name: string; type?: string; entityType?: string }>) || [];
        const nonSpells = items.filter((it) => it.type !== "spell" && it.entityType !== "spell");
        return (
          <div data-testid="inventory-tree-container">
            <div style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>Inventory Items ({nonSpells.length})</div>
            <ul style={{ listStyle: "none", padding: 0, margin: "0.25rem 0" }}>
              {nonSpells.map((it) => (
                <li key={it.id} data-testid={`inventory-item-${it.id}`} style={{ padding: "0.25rem 0" }}>
                  {it.name}
                </li>
              ))}
            </ul>
          </div>
        );
      }
      case "SavingThrowList":
      case "SavingThrowsList": {
        const savesList = Array.isArray(output?.saves) && output.saves.length > 0
          ? (output?.saves as Array<{ key: string; modifier: number; proficient: boolean }>)
          : ['str', 'dex', 'con', 'int', 'wis', 'cha'].map((k) => {
              const mod = Number(((sheetData.abilities as Record<string, { mod?: number }>)?.[k]?.mod) ?? 0);
              return { key: k, modifier: mod, proficient: false };
            });
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "0.375rem" }} data-testid="saving-throws-container">
            {savesList.map((save) => {
              const sign = save.modifier >= 0 ? `+${save.modifier}` : `${save.modifier}`;
              return (
                <button
                  key={save.key}
                  type="button"
                  aria-label={`Roll ${save.key} saving throw (${sign})${save.proficient ? " - Proficient" : ""}`}
                  data-testid={`save-${save.key}-btn`}
                  onClick={() => {
                    if (typeof output?.clickSave === "function" && Array.isArray(output?.saves) && output.saves.length > 0) {
                      (output.clickSave as (k: string) => void)(save.key);
                    } else {
                      dispatcher({
                        cmd: "ROLL_DICE",
                        expression: `1d20${sign}`,
                        reason: `Saving Throw: ${save.key.toUpperCase()}`,
                      });
                    }
                  }}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "0.375rem 0.5rem",
                    backgroundColor: save.proficient ? "var(--atlas-surface)" : "var(--atlas-bg)",
                    border: "1px solid var(--atlas-border)",
                    borderRadius: "4px",
                    color: "var(--atlas-text)",
                    cursor: "pointer",
                    fontSize: "0.75rem",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "0.25rem", textTransform: "uppercase", fontWeight: save.proficient ? 700 : 400 }}>
                    {save.proficient && <span aria-hidden="true" style={{ color: "var(--atlas-info)" }}>●</span>}
                    <span>{save.key}</span>
                  </span>
                  <span className="atlas-tabular-nums" style={{ color: "var(--atlas-action)" }}>{sign}</span>
                </button>
              );
            })}
          </div>
        );
      }
      case "SkillCheckList":
      case "SkillList":
      case "SkillsList": {
        const skillsList = Array.isArray(output?.skills) && output.skills.length > 0
          ? (output?.skills as Array<{ key: string; modifier: number; proficiencyLevel: string; passive: number }>)
          : [
              { key: "acrobatics", modifier: 0, proficiencyLevel: "none", passive: 10 },
              { key: "athletics", modifier: 0, proficiencyLevel: "none", passive: 10 },
              { key: "stealth", modifier: 0, proficiencyLevel: "none", passive: 10 },
              { key: "perception", modifier: 0, proficiencyLevel: "none", passive: 10 },
            ];
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "0.375rem" }} data-testid="skills-container">
            {skillsList.map((sk) => {
              const sign = sk.modifier >= 0 ? `+${sk.modifier}` : `${sk.modifier}`;
              const isProficient = sk.proficiencyLevel && sk.proficiencyLevel !== "none";
              return (
                <button
                  key={sk.key}
                  type="button"
                  aria-label={`Roll ${sk.key} check (${sign})${isProficient ? " - Proficient" : ""}`}
                  data-testid={`skill-${sk.key}-btn`}
                  onClick={() => {
                    if (typeof output?.clickSkill === "function" && Array.isArray(output?.skills) && output.skills.length > 0) {
                      (output.clickSkill as (k: string) => void)(sk.key);
                    } else {
                      dispatcher({
                        cmd: "ROLL_DICE",
                        expression: `1d20${sign}`,
                        reason: `Skill Check: ${sk.key}`,
                      });
                    }
                  }}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "0.375rem 0.5rem",
                    backgroundColor: isProficient ? "var(--atlas-surface)" : "var(--atlas-bg)",
                    border: "1px solid var(--atlas-border)",
                    borderRadius: "4px",
                    color: "var(--atlas-text)",
                    cursor: "pointer",
                    fontSize: "0.75rem",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "0.25rem", textTransform: "capitalize" }}>
                    {isProficient && <span aria-hidden="true" style={{ color: "var(--atlas-info)" }}>●</span>}
                    <span>{sk.key}</span>
                  </span>
                  <span className="atlas-tabular-nums" style={{ color: "var(--atlas-action)" }}>{sign}</span>
                </button>
              );
            })}
          </div>
        );
      }
      case "HitDiceAndDeathSaves":
      case "DeathSavesTracker":
      case "HitDiceTracker":
      case "RestDeathSaves": {
        const currentHD = Number(output?.hitDiceCurrent ?? (sheetData as any).attributes?.hitDiceCurrent ?? 1);
        const maxHD = Number(output?.hitDiceMax ?? (sheetData as any).attributes?.hitDiceMax ?? 1);
        const dieSides = Number(output?.hitDieSides ?? (sheetData as any).attributes?.hitDieSize ?? 10);
        const successes = Number(output?.deathSuccesses ?? (sheetData as any).attributes?.deathSaves?.successes ?? 0);
        const failures = Number(output?.deathFailures ?? (sheetData as any).attributes?.deathSaves?.failures ?? 0);
        return (
          <div data-testid="death-saves-hit-dice-display" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>Hit Dice: </span>
                <strong className="atlas-tabular-nums" style={{ fontSize: "0.875rem", color: "var(--atlas-text)" }}>{currentHD}/{maxHD} d{dieSides}</strong>
              </div>
              <button
                type="button"
                data-testid="spend-hit-die-btn"
                onClick={() => {
                  if (typeof output?.spendHitDie === "function") {
                    (output.spendHitDie as () => void)();
                  } else {
                    dispatcher({ cmd: "ROLL_DICE", expression: `1d${dieSides}`, reason: "Spend Hit Die" });
                  }
                }}
                style={{ padding: "0.25rem 0.5rem", backgroundColor: "var(--atlas-surface-raised)", color: "var(--atlas-text)", border: "1px solid var(--atlas-border)", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
              >
                Spend Die
              </button>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="atlas-tabular-nums" style={{ fontSize: "0.75rem" }}>
                <span style={{ color: "var(--atlas-text)", marginRight: "0.5rem" }}>Successes: {successes}/3</span>
                <span style={{ color: "var(--atlas-danger)" }}>Failures: {failures}/3</span>
              </div>
              <button
                type="button"
                data-testid="death-save-btn"
                onClick={() => {
                  if (typeof output?.rollDeathSave === "function") {
                    (output.rollDeathSave as () => void)();
                  } else {
                    dispatcher({ cmd: "ROLL_DICE", expression: "1d20", reason: "Death Saving Throw" });
                  }
                }}
                style={{ padding: "0.25rem 0.5rem", backgroundColor: "var(--atlas-surface-raised)", color: "var(--atlas-text)", border: "1px solid var(--atlas-border)", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
              >
                Death Save
              </button>
            </div>
          </div>
        );
      }
      case "FeatureTraitList":
      case "FeaturesTraits":
      case "FeaturesTraitsList": {
        const rawFeatures = Array.isArray(output?.features)
          ? (output?.features as Array<{ id: string; name: string; source: string; description: string }>)
          : [];
        return (
          <div data-testid="features-traits-display">
            {rawFeatures.length === 0 ? (
              <div style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>No features recorded.</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {rawFeatures.map((feat) => (
                  <li key={feat.id} data-testid={`feature-${feat.id}`} style={{ marginBottom: "0.5rem", padding: "0.5rem", backgroundColor: "var(--atlas-bg)", borderRadius: "4px", border: "1px solid var(--atlas-border)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.875rem", fontWeight: 600, color: "var(--atlas-info)" }}>
                      <span>{feat.name}</span>
                      <span style={{ fontSize: "0.625rem", color: "var(--atlas-text-muted)" }}>{feat.source}</span>
                    </div>
                    {feat.description && (
                      <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>{feat.description}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      }
      case "ConditionBadgeStrip":
      case "PassiveSenses":
      case "SensesVision": {
        const conds = Array.isArray(output?.conditions)
          ? (output?.conditions as Array<{ id: string; name: string }>)
          : [];
        return (
          <div data-testid="conditions-senses-display">
            <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
              {conds.length === 0 ? (
                <span style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>Normal (No conditions)</span>
              ) : (
                conds.map((c) => (
                  <span
                    key={c.id}
                    data-testid={`condition-badge-${c.id}`}
                    style={{ fontSize: "0.625rem", padding: "0.125rem 0.375rem", backgroundColor: "var(--atlas-info)", color: "var(--atlas-bg)", borderRadius: "4px", border: "1px solid var(--atlas-danger)" }}
                  >
                    {c.name}
                  </span>
                ))
              )}
            </div>
          </div>
        );
      }
      case "NotesMarkdownPane": {
        const bio = String(output?.bio ?? (sheetData as any).bio ?? "");
        const notes = String(output?.notes ?? (sheetData as any).notes ?? "");
        return (
          <div data-testid="notes-pane-content" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {bio && (
              <div>
                <span style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)", fontWeight: 700 }}>Biography</span>
                <div style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)", backgroundColor: "var(--atlas-bg)", padding: "0.5rem", borderRadius: "4px", marginTop: "0.25rem" }}>{bio}</div>
              </div>
            )}
            <div>
              <span style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)", fontWeight: 700 }}>Notes</span>
              <div style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)", backgroundColor: "var(--atlas-bg)", padding: "0.5rem", borderRadius: "4px", marginTop: "0.25rem", whiteSpace: "pre-wrap" }}>{notes || "No campaign notes recorded."}</div>
            </div>
          </div>
        );
      }
      default:
        return (
          <div style={{ fontSize: "0.875rem", color: "var(--atlas-text-muted)" }}>
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
        position: props.embedded ? "relative" : "fixed",
        top: props.embedded ? undefined : 0,
        right: props.embedded ? undefined : 0,
        bottom: props.embedded ? undefined : 0,
        width: props.embedded ? "100%" : "480px",
        height: props.embedded ? "100%" : undefined,
        maxWidth: "100vw",
        backgroundColor: "var(--atlas-bg)",
        borderLeft: isDragOver ? "2px dashed var(--atlas-action)" : props.embedded ? "none" : "1px solid var(--atlas-surface)",
        zIndex: props.embedded ? 1 : 50,
        display: "flex",
        flexDirection: "column",
        boxShadow: props.embedded ? "none" : "-4px 0 16px var(--atlas-surface-raised)",
        color: "var(--atlas-text)",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "1rem 1.25rem",
          borderBottom: "1px solid var(--atlas-surface)",
          backgroundColor: "var(--atlas-bg)",
        }}
      >
        <div>
          <h2 data-testid="actor-sheet-title" style={{ margin: 0, fontSize: "1.25rem", color: "var(--atlas-action)" }}>
            {actor.name}
          </h2>
          <span style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>
            {actor.kind || "Character"} | D&D 5e SRD 5.1
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            type="button"
            data-testid="sheet-padlock-toggle"
            aria-pressed={String(isPadlockUnlocked)}
            aria-label={isPadlockUnlocked ? "Lock Character Sheet" : "Unlock Character Sheet"}
            onClick={() => setIsPadlockUnlocked((prev) => !prev)}
            style={{
              padding: "0.375rem 0.5rem",
              backgroundColor: isPadlockUnlocked ? "var(--atlas-action)" : "var(--atlas-surface)",
              color: isPadlockUnlocked ? "var(--atlas-bg)" : "var(--atlas-text)",
              border: "1px solid var(--atlas-border)",
              borderRadius: "4px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {isPadlockUnlocked ? <PadlockUnlockedIcon size={18} /> : <PadlockLockedIcon size={18} />}
          </button>
          <button
            type="button"
            data-testid="close-sheet-btn"
            onClick={() => {
              appSignals.activeDrawerSignal.value = null;
              props.onClose?.();
            }}
            style={{
              padding: "0.375rem 0.75rem",
              backgroundColor: "var(--atlas-border)",
              color: "var(--atlas-text)",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </header>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "1.25rem",
        }}
      >
        {renderedTree.root ? renderNode(renderedTree.root) : (
          <p style={{ color: "var(--atlas-text-muted)" }}>No sheet layout available.</p>
        )}
      </div>
    </aside>
  );
}
