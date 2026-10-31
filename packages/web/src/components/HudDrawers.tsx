/**
 * ============================================================================
 * TRAME HUD DRAWERS & OVERLAYS (HudDrawers.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Renders the 5 interactive tabletop HUD drawers powered by Preact +
 * `@preact/signals`:
 *   1. Combat Tracker & Initiative Order (`SET_TABLE_MODE`, `ADVANCE_TURN`)
 *   2. ChaCha20 Server-Authoritative Dice Tray (`1d20+5`, `2d6+3`, `4d6kh3` + log)
 *   3. Declarative Character Sheet (`DeclarativeSheetRenderer` + SRD 5.1 layout)
 *   4. 5-Step Character Builder Wizard (`CharacterBuilderWizard`: Ancestry -> Class -> Abilities -> Equipment -> Finalize)
 *   5. Collaborative Wiki Notes & Handout Reveal (`parseWikiMarkdown`, `:::dm`, `:::handout`, `[[Entity]]` links)
 * ============================================================================
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  type ActiveHudDrawer,
  activeCampaignSignal,
  activeDrawerSignal,
  activeWorkspaceTabSignal,
  coreStatsLockedSignal,
  currentUserSignal,
  diceLogSignal,
  isGmSignal,
  lastErrorBannerSignal,
  revealedHandoutsSignal,
  selectedTokenIdSignal,
  selectedTokenSignal,
  tableStateSignal,
  wikiNotesSignal,
} from '../store/signals.ts';
import {
  apiListNotes,
  apiRevealHandout,
  apiUpdateActor,
  apiUpsertNote,
  globalWsClient,
} from '../net/wsClient.ts';
import { DeclarativeSheetRenderer } from '../sheet/DeclarativeSheetRenderer.ts';
import { WidgetRegistry } from '../sheet/WidgetRegistry.ts';
import type { SheetLayoutTree } from '../sheet/types.ts';
import { CharacterBuilderWizard } from '../builder/CharacterBuilderWizard.ts';
import {
  type AbilityId,
  BUILDER_STEPS,
  type BuilderStep,
  DND5E_ABILITIES,
  MAX_POINT_BUY_BUDGET,
  calculatePointBuyCost,
} from '../builder/types.ts';
import {
  filterWikiMarkdownForRole,
  parseWikiMarkdown,
} from '../notes/wikiParser.ts';

WidgetRegistry.registerDefaults();

const CANONICAL_SRD5E_SHEET_TREE: SheetLayoutTree = {
  systemId: 'srd5e',
  version: '1.0',
  root: {
    id: 'root-sheet',
    kind: 'section',
    title: 'SRD 5.1 Character Sheet',
    children: [
      {
        id: 'core-stats-widget',
        kind: 'widget',
        widgetType: 'StatBlock6',
        bindings: {
          str: 'abilities.str.score',
          dex: 'abilities.dex.score',
          con: 'abilities.con.score',
          int: 'abilities.int.score',
          wis: 'abilities.wis.score',
          cha: 'abilities.cha.score',
        },
      },
      {
        id: 'combat-vitals-widget',
        kind: 'widget',
        widgetType: 'ArmorInitiativeSpeed',
        bindings: {
          ac: 'ac',
          initiativeBonus: 'initiativeBonus',
          speedFt: 'speedFt',
        },
      },
      {
        id: 'hp-resource-widget',
        kind: 'widget',
        widgetType: 'ResourceBar',
        bindings: {
          current: 'hp.current',
          max: 'hp.max',
          temp: 'hp.temp',
        },
      },
    ],
  },
};

export function HudDrawers() {
  const activeDrawer = activeDrawerSignal.value;
  const coreStatsLocked = coreStatsLockedSignal.value;
  const activeCampaign = activeCampaignSignal.value;
  const tableState = tableStateSignal.value;
  const selectedToken = selectedTokenSignal.value;
  const diceLog = diceLogSignal.value;
  const notes = wikiNotesSignal.value;
  const revealedHandouts = revealedHandoutsSignal.value;
  const isGm = isGmSignal.value;

  const [diceExpr, setDiceExpr] = useState('1d20+5');

  const [sheetAbilities, setSheetAbilities] = useState<Record<AbilityId, number>>({
    str: 16,
    dex: 14,
    con: 14,
    int: 10,
    wis: 12,
    cha: 10,
  });

  const wizard = useMemo(() => new CharacterBuilderWizard(), []);
  const [builderStep, setBuilderStep] = useState<BuilderStep>(wizard.currentStep);
  const [builderName, setBuilderName] = useState('Lyra Silverhand');
  const [builderAncestry, setBuilderAncestry] = useState('Elf');
  const [builderClass, setBuilderClass] = useState('Wizard');
  const [builderScores, setBuilderScores] = useState<Record<AbilityId, number>>({
    str: 8,
    dex: 14,
    con: 14,
    int: 15,
    wis: 12,
    cha: 8,
  });
  const [builderEquipment, setBuilderEquipment] = useState<string[]>([
    'Quarterstaff',
    'Spellbook',
    "Scholar's Pack",
  ]);
  const [builderErrors, setBuilderErrors] = useState<string[]>([]);

  const [selectedNoteSlug, setSelectedNoteSlug] = useState('goblin-ambush');
  const [noteTitle, setNoteTitle] = useState('Goblin Ambush');
  const [noteMarkdown, setNoteMarkdown] = useState(
    '# Goblin Ambush\nThe party enters the moss-covered dungeon.\n\nSee [[Aria the Ranger]] and [[Goblin Skirmisher]].\n\n:::dm\nSecret GM Trap: DC 15 Perception check at the iron door.\n:::\n\n:::handout{id="handout-map" title="Ancient Parchment" revealed="false"}\nA tattered parchment showing the vault beneath the altar.\n:::',
  );

  useEffect(() => {
    if (!activeCampaign) return;
    apiListNotes(activeCampaign.id)
      .then((res) => {
        wikiNotesSignal.value = res.notes;
        revealedHandoutsSignal.value = res.handouts;
        if (res.notes.length > 0) {
          const first = res.notes[0];
          setSelectedNoteSlug(first.slug);
          setNoteTitle(first.title);
          setNoteMarkdown(first.content_markdown);
        }
      })
      .catch(() => {});
  }, [activeCampaign?.id]);

  function handleSelectDrawer(tab: ActiveHudDrawer) {
    activeDrawerSignal.value = activeDrawerSignal.value === tab ? 'none' : tab;
  }

  // ==========================================================================
  // 1. COMBAT TRACKER ACTIONS
  // ==========================================================================
  function handleStartCombat() {
    const tokens = Object.values(tableState?.tokens || {});
    if (tokens.length === 0) {
      lastErrorBannerSignal.value = 'Spawn or load tokens on the map before starting combat.';
      return;
    }
    globalWsClient.submitCommand({
      cmd: 'SET_TABLE_MODE',
      mode: 'TURN_BY_TURN',
      exploration_paused: false,
      initiative_order: tokens.map((t) => t.id),
    });
  }

  function handleAdvanceTurn() {
    globalWsClient.submitCommand({ cmd: 'ADVANCE_TURN' });
  }

  function handleEndCombat() {
    globalWsClient.submitCommand({
      cmd: 'SET_TABLE_MODE',
      mode: 'EXPLORATION',
      exploration_paused: false,
      initiative_order: [],
    });
  }

  // ==========================================================================
  // 2. DICE TRAY ACTIONS
  // ==========================================================================
  function handleRollDice(exprOverride?: string) {
    const expr = (exprOverride ?? diceExpr).trim();
    if (!expr) return;
    globalWsClient.rollDice(expr);
  }

  // ==========================================================================
  // 3. CHARACTER SHEET AST RENDERING & SAVE
  // ==========================================================================
  const activeActorData = useMemo(() => {
    const tok = selectedToken;
    const dexMod = Math.floor((sheetAbilities.dex - 10) / 2);
    return {
      id: tok?.id ?? 'default-actor',
      name: tok?.name ?? 'Adventurer',
      ac: 12 + dexMod,
      initiativeBonus: dexMod,
      speedFt: tok?.speed_max_ft ?? 30,
      hp: {
        current: tok?.hp ?? 25,
        max: tok?.max_hp ?? 25,
        temp: tok?.temp_hp ?? 0,
      },
      abilities: {
        str: { score: sheetAbilities.str, mod: Math.floor((sheetAbilities.str - 10) / 2) },
        dex: { score: sheetAbilities.dex, mod: Math.floor((sheetAbilities.dex - 10) / 2) },
        con: { score: sheetAbilities.con, mod: Math.floor((sheetAbilities.con - 10) / 2) },
        int: { score: sheetAbilities.int, mod: Math.floor((sheetAbilities.int - 10) / 2) },
        wis: { score: sheetAbilities.wis, mod: Math.floor((sheetAbilities.wis - 10) / 2) },
        cha: { score: sheetAbilities.cha, mod: Math.floor((sheetAbilities.cha - 10) / 2) },
      },
    };
  }, [selectedToken, sheetAbilities]);

  const renderedAstSheet = useMemo(() => {
    return DeclarativeSheetRenderer.render(
      CANONICAL_SRD5E_SHEET_TREE,
      activeActorData,
      {
        userId: currentUserSignal.value?.id,
        isGm,
        isOwner: true,
      },
    );
  }, [activeActorData, isGm]);

  async function handleSaveSheetToServer() {
    if (!activeCampaign) return;
    const actorId = selectedToken?.id ?? crypto.randomUUID();
    try {
      await apiUpdateActor(activeCampaign.id, actorId, {
        name: activeActorData.name,
        hp: activeActorData.hp.current,
        max_hp: activeActorData.hp.max,
        attributes: { ...sheetAbilities },
        sheet: activeActorData as unknown as Record<string, unknown>,
      });
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  }

  // ==========================================================================
  // 4. 5-STEP CHARACTER BUILDER WIZARD
  // ==========================================================================
  function syncWizardDraft() {
    wizard.setName(builderName);
    wizard.setAncestry(builderAncestry);
    wizard.setClass(builderClass);
    wizard.setAbilityScores(builderScores, 'pointBuy');
    wizard.setEquipment(builderEquipment);
  }

  function handleBuilderNext() {
    syncWizardDraft();
    const validation = wizard.validateStep(builderStep);
    if (!validation.valid) {
      setBuilderErrors(validation.errors);
      return;
    }
    setBuilderErrors([]);
    const idx = BUILDER_STEPS.indexOf(builderStep);
    if (idx < BUILDER_STEPS.length - 1) {
      const nextStep = BUILDER_STEPS[idx + 1];
      wizard.goToStep(nextStep);
      setBuilderStep(nextStep);
    }
  }

  function handleBuilderPrev() {
    setBuilderErrors([]);
    const idx = BUILDER_STEPS.indexOf(builderStep);
    if (idx > 0) {
      const prevStep = BUILDER_STEPS[idx - 1];
      wizard.goToStep(prevStep);
      setBuilderStep(prevStep);
    }
  }

  async function handleBuilderFinalize() {
    syncWizardDraft();
    const validation = wizard.validateStep('review');
    if (!validation.valid) {
      setBuilderErrors(validation.errors);
      return;
    }
    setBuilderErrors([]);
    const tokenId = crypto.randomUUID();
    const conMod = Math.floor((builderScores.con - 10) / 2);
    const maxHp = Math.max(8, 10 + conMod * 2);

    if (activeCampaign) {
      try {
        await apiUpdateActor(activeCampaign.id, tokenId, {
          name: builderName.trim() || 'New Hero',
          hp: maxHp,
          max_hp: maxHp,
          attributes: { ...builderScores },
          sheet: {
            ancestry: builderAncestry,
            class: builderClass,
            equipment: builderEquipment,
          },
          spawn_on_map: true,
        });
      } catch (err) {
        lastErrorBannerSignal.value = (err as Error).message;
      }
    }

    selectedTokenIdSignal.value = tokenId;
    setSheetAbilities({ ...builderScores });
    activeDrawerSignal.value = 'sheet';
  }

  // ==========================================================================
  // 5. COLLABORATIVE WIKI NOTES & HANDOUT REVEAL
  // ==========================================================================
  async function handleSaveNote() {
    if (!activeCampaign) return;
    try {
      const saved = await apiUpsertNote(
        activeCampaign.id,
        selectedNoteSlug,
        noteTitle,
        noteMarkdown,
      );
      const existing = wikiNotesSignal.value.filter((n) => n.slug !== saved.slug);
      wikiNotesSignal.value = [...existing, saved];
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  }

  async function handleRevealHandout(handoutId: string, title: string, content: string) {
    if (!activeCampaign) return;
    try {
      const updatedMarkdown = noteMarkdown.replace(
        `id="${handoutId}" title="${title}" revealed="false"`,
        `id="${handoutId}" title="${title}" revealed="true"`,
      );
      setNoteMarkdown(updatedMarkdown);
      await apiUpsertNote(activeCampaign.id, selectedNoteSlug, noteTitle, updatedMarkdown);
      await apiRevealHandout(activeCampaign.id, handoutId, title, content);
      const refreshed = await apiListNotes(activeCampaign.id);
      wikiNotesSignal.value = refreshed.notes;
      revealedHandoutsSignal.value = refreshed.handouts;
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  }

  const parsedNote = useMemo(() => {
    const visibleMd = filterWikiMarkdownForRole(noteMarkdown, isGm);
    return parseWikiMarkdown(visibleMd);
  }, [noteMarkdown, isGm]);

  const pointBuySpent = calculatePointBuyCost(builderScores);

  return (
    <>
      <aside
        data-testid="hud-drawer-rail"
        style={{
          width: '3.4rem',
          background: '#131722',
          borderLeft: '1px solid #1e293b',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '0.75rem 0',
          gap: '0.5rem',
          zIndex: 20,
        }}
      >
        {(
          [
            { id: 'combat', label: '⚔️', title: 'Combat Tracker' },
            { id: 'dice', label: '🎲', title: 'Dice Tray' },
            { id: 'sheet', label: '📜', title: 'Character Sheet (Padlock Protected)' },
            { id: 'notes', label: '📖', title: 'Wiki Notes & Handouts' },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.title}
            data-testid={`drawer-tab-${item.id}`}
            onClick={() => handleSelectDrawer(item.id)}
            style={{
              width: '2.5rem',
              height: '2.5rem',
              borderRadius: '8px',
              border: activeDrawer === item.id ? '1px solid #6366f1' : '1px solid transparent',
              background: activeDrawer === item.id ? 'rgba(99, 102, 241, 0.25)' : 'transparent',
              color: '#f8fafc',
              fontSize: '1.15rem',
              cursor: 'pointer',
            }}
          >
            {item.label}
          </button>
        ))}
      </aside>

      {activeDrawer !== 'none' && (
        <section
          data-testid={`hud-drawer-${activeDrawer}`}
          style={{
            width: '380px',
            maxWidth: '90vw',
            background: '#131722',
            borderLeft: '1px solid #1e293b',
            color: '#e2e8f0',
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
            padding: '1rem',
            gap: '0.9rem',
            zIndex: 19,
          }}
        >
          {/* TAB 1: COMBAT TRACKER */}
          {activeDrawer === 'combat' && (
            <div data-testid="combat-tracker-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1rem' }}>Combat & Initiative</h3>
                <span
                  data-testid="combat-mode-badge"
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.2rem 0.5rem',
                    borderRadius: '999px',
                    background:
                      tableState?.mode === 'TURN_BY_TURN'
                        ? 'rgba(239, 68, 68, 0.2)'
                        : 'rgba(56, 189, 248, 0.15)',
                    color: tableState?.mode === 'TURN_BY_TURN' ? '#fca5a5' : '#38bdf8',
                    fontWeight: 700,
                  }}
                >
                  {tableState?.mode === 'TURN_BY_TURN'
                    ? `Round ${tableState.round ?? 1}`
                    : 'Exploration'}
                </span>
              </div>

              <div style={{ display: 'flex', gap: '0.4rem' }}>
                {tableState?.mode !== 'TURN_BY_TURN' ? (
                  <button
                    type="button"
                    data-testid="start-combat-btn"
                    onClick={handleStartCombat}
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: '#dc2626',
                      color: '#fff',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Roll Initiative & Start Combat
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      data-testid="advance-turn-btn"
                      onClick={handleAdvanceTurn}
                      style={{
                        flex: 1,
                        padding: '0.5rem',
                        borderRadius: '6px',
                        border: 'none',
                        background: '#4f46e5',
                        color: '#fff',
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Next Turn →
                    </button>
                    <button
                      type="button"
                      data-testid="end-combat-btn"
                      onClick={handleEndCombat}
                      style={{
                        padding: '0.5rem 0.75rem',
                        borderRadius: '6px',
                        border: '1px solid #475569',
                        background: '#1e293b',
                        color: '#cbd5e1',
                        cursor: 'pointer',
                      }}
                    >
                      End
                    </button>
                  </>
                )}
              </div>

              {tableState && tableState.initiative_order.length > 0 && (
                <div data-testid="initiative-order-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {tableState.initiative_order.map((tokenId, idx) => {
                    const tok = tableState.tokens[tokenId];
                    const isActive = idx === tableState.active_turn_index;
                    return (
                      <div
                        key={tokenId}
                        data-testid={`initiative-row-${tokenId}`}
                        onClick={() => {
                          selectedTokenIdSignal.value = tokenId;
                        }}
                        style={{
                          padding: '0.55rem 0.75rem',
                          borderRadius: '8px',
                          border: isActive ? '1px solid #38bdf8' : '1px solid #1e293b',
                          background: isActive ? 'rgba(56, 189, 248, 0.14)' : '#0f172a',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>
                            {isActive ? '▶ ' : ''}
                            {tok?.name ?? tokenId}
                          </div>
                          {tok && (
                            <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                              HP {tok.hp}/{tok.max_hp} • Speed {tok.speed_remaining_ft} ft
                            </div>
                          )}
                        </div>
                        <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#fbbf24' }}>
                          #{idx + 1}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: CHACHA20 DICE TRAY */}
          {activeDrawer === 'dice' && (
            <div data-testid="dice-tray-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>ChaCha20 CSPRNG Dice Tray</h3>

              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                {['1d20', '1d20+5', '2d6+3', '1d8+2', '4d6kh3', '2d20kh1+7'].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    data-testid={`dice-preset-${preset}`}
                    onClick={() => {
                      setDiceExpr(preset);
                      handleRollDice(preset);
                    }}
                    style={{
                      padding: '0.35rem 0.6rem',
                      borderRadius: '6px',
                      border: '1px solid #334155',
                      background: '#1e293b',
                      color: '#e2e8f0',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {preset}
                  </button>
                ))}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRollDice();
                }}
                style={{ display: 'flex', gap: '0.4rem' }}
              >
                <input
                  type="text"
                  data-testid="dice-expression-input"
                  value={diceExpr}
                  onInput={(e) => setDiceExpr((e.currentTarget as HTMLInputElement).value)}
                  placeholder="e.g. 2d20kh1+5"
                  style={{
                    flex: 1,
                    padding: '0.5rem 0.65rem',
                    borderRadius: '6px',
                    border: '1px solid #334155',
                    background: '#0f172a',
                    color: '#f8fafc',
                  }}
                />
                <button
                  type="submit"
                  data-testid="roll-dice-submit-btn"
                  style={{
                    padding: '0.5rem 0.9rem',
                    borderRadius: '6px',
                    border: 'none',
                    background: '#4f46e5',
                    color: '#fff',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Roll
                </button>
              </form>

              <div
                data-testid="dice-log-list"
                style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', marginTop: '0.25rem' }}
              >
                {diceLog.length === 0 ? (
                  <p style={{ color: '#64748b', fontSize: '0.85rem', margin: 0 }}>
                    No rolls yet. Click a preset or enter a formula above.
                  </p>
                ) : (
                  diceLog.map((entry) => {
                    const flatRolls = (entry.terms || []).flatMap((t) => t.rolls);
                    return (
                      <div
                        key={entry.roll_id}
                        data-testid="dice-log-entry"
                        style={{
                          padding: '0.6rem 0.75rem',
                          borderRadius: '8px',
                          background: '#0f172a',
                          border: '1px solid #1e293b',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#cbd5e1' }}>
                            {entry.expression}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                            Rolls: [{flatRolls.join(', ')}]
                          </div>
                        </div>
                        <span
                          data-testid="dice-roll-total"
                          style={{
                            fontSize: '1.25rem',
                            fontWeight: 800,
                            color: '#38bdf8',
                          }}
                        >
                          {entry.total ?? '??'}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* TAB 3: DECLARATIVE CHARACTER SHEET (PADLOCK PROTECTED) */}
          {activeDrawer === 'sheet' && (
            <div data-testid="character-sheet-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.4rem' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1rem' }}>{activeActorData.name}</h3>
                  <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                    AST System: {renderedAstSheet.systemId} (v{renderedAstSheet.version})
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                  <button
                    type="button"
                    data-testid="sheet-lock-toggle-btn"
                    onClick={() => {
                      coreStatsLockedSignal.value = !coreStatsLocked;
                    }}
                    title={
                      coreStatsLocked
                        ? 'Core stats are locked against accidental edits. Click to unlock.'
                        : 'Core stats are unlocked for editing. Click to lock.'
                    }
                    style={{
                      padding: '0.32rem 0.6rem',
                      borderRadius: '6px',
                      border: coreStatsLocked ? '1px solid #475569' : '1px solid #f59e0b',
                      background: coreStatsLocked ? '#1e293b' : 'rgba(245, 158, 11, 0.2)',
                      color: coreStatsLocked ? '#cbd5e1' : '#fcd34d',
                      fontWeight: 700,
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                  >
                    {coreStatsLocked ? '🔒 Locked' : '🔓 Edit Mode'}
                  </button>
                  <button
                    type="button"
                    data-testid="save-sheet-btn"
                    onClick={handleSaveSheetToServer}
                    style={{
                      padding: '0.35rem 0.7rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: '#10b981',
                      color: '#052e16',
                      fontWeight: 700,
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    Save Sheet
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  data-testid="open-full-character-hub-btn"
                  onClick={() => {
                    activeWorkspaceTabSignal.value = 'characters';
                  }}
                  style={{
                    flex: 1,
                    padding: '0.35rem 0.55rem',
                    borderRadius: '6px',
                    border: '1px solid #6366f1',
                    background: 'rgba(99, 102, 241, 0.16)',
                    color: '#c7d2fe',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Open Full Sheet, Level-Up & Compendium →
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.45rem' }}>
                <div style={{ background: '#0f172a', padding: '0.55rem', borderRadius: '8px', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>ARMOR CLASS</div>
                  <div data-testid="sheet-ac-value" style={{ fontSize: '1.15rem', fontWeight: 800 }}>
                    {activeActorData.ac}
                  </div>
                </div>
                <div style={{ background: '#0f172a', padding: '0.55rem', borderRadius: '8px', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>INITIATIVE</div>
                  <div style={{ fontSize: '1.15rem', fontWeight: 800 }}>
                    {activeActorData.initiativeBonus >= 0
                      ? `+${activeActorData.initiativeBonus}`
                      : activeActorData.initiativeBonus}
                  </div>
                </div>
                <div style={{ background: '#0f172a', padding: '0.55rem', borderRadius: '8px', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>SPEED</div>
                  <div style={{ fontSize: '1.15rem', fontWeight: 800 }}>{activeActorData.speedFt} ft</div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.45rem' }}>
                {DND5E_ABILITIES.map((ab) => {
                  const score = sheetAbilities[ab];
                  const mod = Math.floor((score - 10) / 2);
                  const modStr = mod >= 0 ? `+${mod}` : `${mod}`;
                  return (
                    <div
                      key={ab}
                      data-testid={`sheet-ability-${ab}`}
                      style={{
                        background: '#0f172a',
                        border: coreStatsLocked ? '1px solid #1e293b' : '1px solid #f59e0b',
                        borderRadius: '8px',
                        padding: '0.5rem',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '0.25rem',
                      }}
                    >
                      <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', color: '#94a3b8' }}>
                        {ab}
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        disabled={coreStatsLocked}
                        readOnly={coreStatsLocked}
                        data-testid={`sheet-ability-input-${ab}`}
                        value={score}
                        onInput={(e) => {
                          if (coreStatsLocked) return;
                          const val = Number((e.currentTarget as HTMLInputElement).value) || 10;
                          setSheetAbilities((prev) => ({ ...prev, [ab]: val }));
                        }}
                        style={{
                          width: '3.2rem',
                          textAlign: 'center',
                          background: coreStatsLocked ? '#0f172a' : '#1e293b',
                          border: coreStatsLocked ? '1px solid transparent' : '1px solid #f59e0b',
                          borderRadius: '4px',
                          color: '#f8fafc',
                          fontWeight: 700,
                          opacity: coreStatsLocked ? 0.9 : 1,
                        }}
                      />
                      <button
                        type="button"
                        data-testid={`sheet-roll-${ab}-btn`}
                        onClick={() => {
                          const expr = mod >= 0 ? `1d20+${mod}` : `1d20${mod}`;
                          globalWsClient.rollDice(expr);
                          activeDrawerSignal.value = 'dice';
                        }}
                        style={{
                          padding: '0.2rem 0.45rem',
                          borderRadius: '4px',
                          border: 'none',
                          background: 'rgba(99, 102, 241, 0.2)',
                          color: '#a5b4fc',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        Roll {modStr}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 4: 5-STEP CHARACTER BUILDER WIZARD */}
          {activeDrawer === 'wizard' && (
            <div data-testid="character-builder-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>5-Step Character Builder</h3>

              <div style={{ display: 'flex', gap: '0.25rem' }}>
                {BUILDER_STEPS.map((step, i) => (
                  <div
                    key={step}
                    data-testid={`builder-step-indicator-${step}`}
                    style={{
                      flex: 1,
                      padding: '0.3rem 0.2rem',
                      textAlign: 'center',
                      fontSize: '0.7rem',
                      borderRadius: '4px',
                      background: builderStep === step ? '#4f46e5' : '#0f172a',
                      color: builderStep === step ? '#fff' : '#94a3b8',
                      fontWeight: builderStep === step ? 700 : 500,
                      textTransform: 'capitalize',
                    }}
                  >
                    {i + 1}. {step}
                  </div>
                ))}
              </div>

              {builderErrors.length > 0 && (
                <div
                  data-testid="builder-validation-errors"
                  style={{
                    padding: '0.5rem 0.65rem',
                    borderRadius: '6px',
                    background: 'rgba(239, 68, 68, 0.18)',
                    border: '1px solid #ef4444',
                    color: '#fca5a5',
                    fontSize: '0.8rem',
                  }}
                >
                  {builderErrors.join(' ')}
                </div>
              )}

              {builderStep === 'ancestry' && (
                <div data-testid="builder-step-ancestry" style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Character Name</label>
                  <input
                    type="text"
                    data-testid="builder-name-input"
                    value={builderName}
                    onInput={(e) => setBuilderName((e.currentTarget as HTMLInputElement).value)}
                    style={{
                      padding: '0.5rem',
                      borderRadius: '6px',
                      border: '1px solid #334155',
                      background: '#0f172a',
                      color: '#f8fafc',
                    }}
                  />
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Select SRD 5.1 Ancestry</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                    {['Elf', 'Dwarf', 'Human', 'Halfling', 'Dragonborn', 'Tiefling'].map((anc) => (
                      <button
                        key={anc}
                        type="button"
                        data-testid={`ancestry-option-${anc}`}
                        onClick={() => setBuilderAncestry(anc)}
                        style={{
                          padding: '0.5rem',
                          borderRadius: '6px',
                          border: builderAncestry === anc ? '1px solid #6366f1' : '1px solid #1e293b',
                          background: builderAncestry === anc ? 'rgba(99, 102, 241, 0.25)' : '#0f172a',
                          color: '#f8fafc',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        {anc}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {builderStep === 'class' && (
                <div data-testid="builder-step-class" style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Select SRD 5.1 Class</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                    {['Wizard', 'Fighter', 'Rogue', 'Cleric', 'Ranger', 'Paladin'].map((cls) => (
                      <button
                        key={cls}
                        type="button"
                        data-testid={`class-option-${cls}`}
                        onClick={() => setBuilderClass(cls)}
                        style={{
                          padding: '0.5rem',
                          borderRadius: '6px',
                          border: builderClass === cls ? '1px solid #6366f1' : '1px solid #1e293b',
                          background: builderClass === cls ? 'rgba(99, 102, 241, 0.25)' : '#0f172a',
                          color: '#f8fafc',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        {cls}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {builderStep === 'abilityScores' && (
                <div data-testid="builder-step-abilities" style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                    <span>Point Buy Budget (8–15):</span>
                    <strong
                      data-testid="point-buy-spent"
                      style={{ color: pointBuySpent <= MAX_POINT_BUY_BUDGET ? '#4ade80' : '#f87171' }}
                    >
                      {pointBuySpent} / {MAX_POINT_BUY_BUDGET} pts
                    </strong>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.45rem' }}>
                    {DND5E_ABILITIES.map((ab) => (
                      <div
                        key={ab}
                        style={{
                          background: '#0f172a',
                          padding: '0.45rem 0.6rem',
                          borderRadius: '6px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <strong style={{ textTransform: 'uppercase', fontSize: '0.8rem' }}>{ab}</strong>
                        <input
                          type="number"
                          min={8}
                          max={15}
                          data-testid={`builder-score-${ab}`}
                          value={builderScores[ab]}
                          onInput={(e) => {
                            const val = Math.max(
                              8,
                              Math.min(15, Number((e.currentTarget as HTMLInputElement).value) || 8),
                            );
                            setBuilderScores((prev) => ({ ...prev, [ab]: val }));
                          }}
                          style={{
                            width: '3rem',
                            padding: '0.2rem',
                            borderRadius: '4px',
                            border: '1px solid #334155',
                            background: '#1e293b',
                            color: '#fff',
                            textAlign: 'center',
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {builderStep === 'equipment' && (
                <div data-testid="builder-step-equipment" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Starting Equipment Package</label>
                  {[
                    'Longsword & Shield',
                    'Shortbow & Quiver (20 Arrows)',
                    'Quarterstaff',
                    'Spellbook',
                    "Scholar's Pack",
                    "Explorer's Pack",
                    "Thieves' Tools",
                  ].map((item) => {
                    const checked = builderEquipment.includes(item);
                    return (
                      <label
                        key={item}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          padding: '0.4rem 0.6rem',
                          background: '#0f172a',
                          borderRadius: '6px',
                          fontSize: '0.84rem',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setBuilderEquipment((prev) =>
                              checked ? prev.filter((x) => x !== item) : [...prev, item],
                            );
                          }}
                        />
                        {item}
                      </label>
                    );
                  })}
                </div>
              )}

              {builderStep === 'review' && (
                <div
                  data-testid="builder-step-review"
                  style={{
                    background: '#0f172a',
                    padding: '0.75rem',
                    borderRadius: '8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.4rem',
                    fontSize: '0.85rem',
                  }}
                >
                  <div>
                    <strong>Name:</strong> {builderName}
                  </div>
                  <div>
                    <strong>Ancestry & Class:</strong> {builderAncestry} {builderClass}
                  </div>
                  <div>
                    <strong>Scores:</strong> STR {builderScores.str}, DEX {builderScores.dex}, CON{' '}
                    {builderScores.con}, INT {builderScores.int}, WIS {builderScores.wis}, CHA{' '}
                    {builderScores.cha}
                  </div>
                  <div>
                    <strong>Equipment:</strong> {builderEquipment.join(', ')}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginTop: '0.25rem' }}>
                <button
                  type="button"
                  data-testid="builder-prev-btn"
                  disabled={builderStep === 'ancestry'}
                  onClick={handleBuilderPrev}
                  style={{
                    padding: '0.45rem 0.85rem',
                    borderRadius: '6px',
                    border: '1px solid #334155',
                    background: '#1e293b',
                    color: '#cbd5e1',
                    cursor: builderStep === 'ancestry' ? 'not-allowed' : 'pointer',
                  }}
                >
                  ← Back
                </button>
                {builderStep !== 'review' ? (
                  <button
                    type="button"
                    data-testid="builder-next-btn"
                    onClick={handleBuilderNext}
                    style={{
                      padding: '0.45rem 0.95rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: '#4f46e5',
                      color: '#fff',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Next Step →
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="builder-finalize-btn"
                    onClick={handleBuilderFinalize}
                    style={{
                      padding: '0.45rem 0.95rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: '#10b981',
                      color: '#052e16',
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    Finalize & Spawn Hero
                  </button>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: COLLABORATIVE WIKI NOTES & HANDOUT REVEAL */}
          {activeDrawer === 'notes' && (
            <div data-testid="wiki-notes-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1rem' }}>Campaign Wiki & Handouts</h3>
                <button
                  type="button"
                  data-testid="save-note-btn"
                  onClick={handleSaveNote}
                  style={{
                    padding: '0.3rem 0.65rem',
                    borderRadius: '6px',
                    border: 'none',
                    background: '#4f46e5',
                    color: '#fff',
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Save Note
                </button>
              </div>

              {notes.length > 0 && (
                <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                  {notes.map((n) => (
                    <button
                      key={n.slug}
                      type="button"
                      onClick={() => {
                        setSelectedNoteSlug(n.slug);
                        setNoteTitle(n.title);
                        setNoteMarkdown(n.content_markdown);
                      }}
                      style={{
                        padding: '0.25rem 0.5rem',
                        borderRadius: '4px',
                        border: selectedNoteSlug === n.slug ? '1px solid #6366f1' : '1px solid #334155',
                        background: '#0f172a',
                        color: '#e2e8f0',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                      }}
                    >
                      {n.title}
                    </button>
                  ))}
                </div>
              )}

              <input
                type="text"
                data-testid="note-title-input"
                value={noteTitle}
                onInput={(e) => setNoteTitle((e.currentTarget as HTMLInputElement).value)}
                style={{
                  padding: '0.4rem 0.6rem',
                  borderRadius: '6px',
                  border: '1px solid #334155',
                  background: '#0f172a',
                  color: '#f8fafc',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                }}
              />

              {isGm && (
                <textarea
                  rows={5}
                  data-testid="note-markdown-textarea"
                  value={noteMarkdown}
                  onInput={(e) => setNoteMarkdown((e.currentTarget as HTMLTextAreaElement).value)}
                  style={{
                    padding: '0.5rem',
                    borderRadius: '6px',
                    border: '1px solid #334155',
                    background: '#0f172a',
                    color: '#e2e8f0',
                    fontFamily: 'monospace',
                    fontSize: '0.78rem',
                  }}
                />
              )}

              <div
                data-testid="wiki-rendered-preview"
                style={{
                  background: '#0f172a',
                  border: '1px solid #1e293b',
                  borderRadius: '8px',
                  padding: '0.65rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.55rem',
                  fontSize: '0.83rem',
                }}
              >
                {parsedNote.ast.map((node, i) => {
                  if (node.type === 'text') {
                    return (
                      <div key={i} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
                        {node.content}
                      </div>
                    );
                  }
                  if (node.type === 'dm') {
                    return (
                      <div
                        key={i}
                        data-testid="wiki-dm-secret-block"
                        style={{
                          padding: '0.45rem 0.6rem',
                          borderRadius: '6px',
                          background: 'rgba(245, 158, 11, 0.14)',
                          borderLeft: '3px solid #f59e0b',
                          color: '#fde68a',
                          fontSize: '0.78rem',
                        }}
                      >
                        <strong>GM Secret:</strong> {node.content}
                      </div>
                    );
                  }
                  if (node.type === 'handout') {
                    return (
                      <div
                        key={i}
                        data-testid={`wiki-handout-block-${node.id}`}
                        style={{
                          padding: '0.5rem 0.65rem',
                          borderRadius: '6px',
                          background: 'rgba(56, 189, 248, 0.12)',
                          border: '1px solid #0284c7',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.35rem',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <strong style={{ color: '#7dd3fc' }}>📜 {node.title}</strong>
                          {isGm && (
                            <button
                              type="button"
                              data-testid={`reveal-handout-btn-${node.id}`}
                              onClick={() => handleRevealHandout(node.id, node.title, node.content)}
                              style={{
                                padding: '0.2rem 0.5rem',
                                borderRadius: '4px',
                                border: 'none',
                                background: '#0284c7',
                                color: '#fff',
                                fontSize: '0.72rem',
                                fontWeight: 700,
                                cursor: 'pointer',
                              }}
                            >
                              {node.revealed ? 'Re-Broadcast' : 'Reveal to Players'}
                            </button>
                          )}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: '#e0f2fe' }}>{node.content}</div>
                      </div>
                    );
                  }
                  return null;
                })}

                {parsedNote.wikilinks.length > 0 && (
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', paddingTop: '0.3rem' }}>
                    {parsedNote.wikilinks.map((wl, idx) => (
                      <button
                        key={idx}
                        type="button"
                        data-testid={`wikilink-chip-${wl.target}`}
                        onClick={() => {
                          const match = Object.values(tableState?.tokens || {}).find(
                            (t) => t.name.toLowerCase() === wl.target.toLowerCase(),
                          );
                          if (match) {
                            selectedTokenIdSignal.value = match.id;
                          }
                        }}
                        style={{
                          padding: '0.2rem 0.45rem',
                          borderRadius: '999px',
                          border: '1px solid #38bdf8',
                          background: 'rgba(56, 189, 248, 0.12)',
                          color: '#38bdf8',
                          fontSize: '0.74rem',
                          cursor: 'pointer',
                        }}
                      >
                        [[{wl.label}]]
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {revealedHandouts.length > 0 && (
                <div
                  data-testid="revealed-handouts-list"
                  style={{
                    padding: '0.55rem',
                    borderRadius: '6px',
                    background: 'rgba(16, 185, 129, 0.12)',
                    border: '1px solid #10b981',
                    fontSize: '0.78rem',
                  }}
                >
                  <strong style={{ color: '#6ee7b7' }}>Revealed Handouts:</strong>
                  {revealedHandouts.map((h, idx) => (
                    <div key={idx} style={{ marginTop: '0.25rem' }}>
                      <strong>{h.title}:</strong> {h.content}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}
