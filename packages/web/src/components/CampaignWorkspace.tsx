/**
 * ============================================================================
 * 4-TAB CAMPAIGN WORKSPACE HUB (CampaignWorkspace.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Implements the unified TRAME `CampaignWorkspace` defined in `GLOSSARY.md`:
 *   - Tab 1 (`characters`): Characters & Party Roster, Padlock-protected
 *     Character Sheet (`coreStatsLockedSignal` + GM `CoreBuildLock`),
 *     D&D 5e `LevelUpModal` (levels 1–20), Short/Long Rest actions,
 *     5-Step `CharacterBuilderWizard` modal for new Level 1 heroes, and
 *     the Bilingual (FR/EN) SRD 5.1 Compendium Drawer.
 *   - Tab 2 (`maps`): GM Map Prep Studio (upload `.uvtt`, starter dungeon,
 *     create/save prepared maps, toggle `revealed_to_players`, push to live
 *     table, combat automation mode selector) OR Player `SceneAtlas`
 *     (browsing GM-revealed maps).
 *   - Tab 3 (`documents`): 3-Scope Collaborative Wiki Notes (`private`,
 *     `party`, `dm_only`) with `:::dm` and `:::handout` fenced blocks, plus
 *     the Revealed Handouts Archive Gallery.
 *   - Tab 4 (`table`): Full-bleed WebGL2 / Canvas2D `TableCanvas` with
 *     right-click context menu and `HudDrawers`.
 * ============================================================================
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  activeCampaignSignal,
  activeDrawerSignal,
  activeHandoutModalSignal,
  activeWorkspaceTabSignal,
  type CampaignActorRecord,
  combatAutomationModeSignal,
  type CombatAutomationMode,
  coreStatsLockedSignal,
  currentUserSignal,
  isGmSignal,
  lastErrorBannerSignal,
  preparedMapsSignal,
  revealedHandoutsSignal,
  selectedTokenIdSignal,
  selectedTokenSignal,
  tableStateSignal,
  wikiNotesSignal,
} from '../store/signals.ts';
import {
  apiGenerateStarterMap,
  apiGetCampaign,
  apiListMaps,
  apiListNotes,
  apiRevealHandout,
  apiUpdateActor,
  apiUploadUvttMap,
  apiUpsertMap,
  apiUpsertNote,
  buildDefaultSpawnTokenPayload,
  globalWsClient,
} from '../net/wsClient.ts';
import {
  type AbilityId,
  DND5E_ABILITIES,
} from '../builder/types.ts';
import {
  BILINGUAL_SRD_COMPENDIUM,
  type BilingualCompendiumEntry,
  formatDistanceFt,
  localeSignal,
  searchBilingualCompendium,
  t,
  unitSystemSignal,
} from '../i18n/index.ts';
import { filterWikiMarkdownForRole, parseWikiMarkdown } from '../notes/wikiParser.ts';
import { TableCanvas } from './TableCanvas.tsx';
import { HudDrawers } from './HudDrawers.tsx';

const CLASS_HIT_DIE: Record<string, number> = {
  Barbarian: 12,
  Fighter: 10,
  Paladin: 10,
  Ranger: 10,
  Cleric: 8,
  Druid: 8,
  Monk: 8,
  Rogue: 8,
  Warlock: 8,
  Bard: 8,
  Sorcerer: 6,
  Wizard: 6,
};

export function CampaignWorkspace() {
  const activeTab = activeWorkspaceTabSignal.value;
  const activeCampaign = activeCampaignSignal.value;
  const currentUser = currentUserSignal.value;
  const isGm = isGmSignal.value;
  const tableState = tableStateSignal.value;
  const selectedToken = selectedTokenSignal.value;
  const coreStatsLocked = coreStatsLockedSignal.value;
  const preparedMaps = preparedMapsSignal.value;
  const notes = wikiNotesSignal.value;
  const handouts = revealedHandoutsSignal.value;
  const activeHandoutModal = activeHandoutModalSignal.value;
  const locale = localeSignal.value;
  const unitSystem = unitSystemSignal.value;
  const automationMode = combatAutomationModeSignal.value;

  // Selected character in Tab 1
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null);
  const [compendiumQuery, setCompendiumQuery] = useState('');
  const [compendiumCategory, setCompendiumCategory] = useState<
    BilingualCompendiumEntry['category'] | 'all'
  >('all');

  // Level-Up Modal state
  const [levelUpOpen, setLevelUpOpen] = useState(false);
  const [levelUpHpMode, setLevelUpHpMode] = useState<'average' | 'roll'>('average');
  const [levelUpAsiAbility, setLevelUpAsiAbility] = useState<AbilityId>('str');

  // Editable sheet state for selected actor
  const [editName, setEditName] = useState('Aelar');
  const [editClass, setEditClass] = useState('Wizard');
  const [editAncestry, setEditAncestry] = useState('Elf');
  const [editLevel, setEditLevel] = useState(1);
  const [editHp, setEditHp] = useState(24);
  const [editMaxHp, setEditMaxHp] = useState(24);
  const [editGmCoreLocked, setEditGmCoreLocked] = useState(false);
  const [editAbilities, setEditAbilities] = useState<Record<AbilityId, number>>({
    str: 10,
    dex: 14,
    con: 14,
    int: 16,
    wis: 12,
    cha: 10,
  });
  const [editEquipment, setEditEquipment] = useState<string[]>([
    'Quarterstaff',
    'Spellbook',
    "Scholar's Pack",
  ]);
  const [editSpells, setEditSpells] = useState<string[]>(['Fireball', 'Magic Missile']);

  // Tab 2: Map Prep Studio state
  const [newMapName, setNewMapName] = useState('Goblin Ambush Cavern');
  const [newMapWidth, setNewMapWidth] = useState(1200);
  const [newMapHeight, setNewMapHeight] = useState(800);
  const [newMapRevealed, setNewMapRevealed] = useState(true);

  // Tab 3: Journal & Documents state
  const [noteScopeFilter, setNoteScopeFilter] = useState<'all' | 'private' | 'party' | 'dm_only'>('all');
  const [selectedNoteSlug, setSelectedNoteSlug] = useState('goblin-ambush');
  const [noteTitle, setNoteTitle] = useState('Goblin Ambush Briefing');
  const [noteFolder, setNoteFolder] = useState<'private' | 'party' | 'dm_only'>('party');
  const [noteMarkdown, setNoteMarkdown] = useState(
    'The party approaches [[Klarg]] near the old bridge.\n\n:::dm\nHidden pit trap DC 14 Dexterity save.\n:::\n\n:::handout id="h1" title="Crumpled Map" revealed="false"\nFollow the underground river to the Cragmaw throne room.\n:::',
  );

  // Sync maps & notes on campaign load
  useEffect(() => {
    if (!activeCampaign) return;
    apiListMaps(activeCampaign.id)
      .then((res) => {
        preparedMapsSignal.value = res.maps;
      })
      .catch(() => {});
    apiListNotes(activeCampaign.id)
      .then((res) => {
        wikiNotesSignal.value = res.notes;
        revealedHandoutsSignal.value = res.handouts;
      })
      .catch(() => {});
  }, [activeCampaign?.id]);

  // Keep selected actor synced with campaign actors or live tokens
  const actorsList: CampaignActorRecord[] = useMemo(() => {
    const campaignActors = activeCampaign?.actors ?? [];
    if (campaignActors.length > 0) return campaignActors;
    const liveTokens = Object.values(tableState?.tokens ?? {});
    return liveTokens.map((tok) => ({
      id: tok.id,
      campaign_id: activeCampaign?.id ?? '',
      owner_user_id: tok.owner_user_id ?? undefined,
      name: tok.name,
      hp: tok.hp,
      max_hp: tok.max_hp,
      attributes: { str: 14, dex: 14, con: 14, int: 12, wis: 12, cha: 10 },
      sheet: { class: 'Fighter', ancestry: 'Human', level: 1 },
    }));
  }, [activeCampaign?.actors, tableState?.tokens, activeCampaign?.id]);

  const activeActor = useMemo(() => {
    if (selectedActorId) {
      const found = actorsList.find((a) => a.id === selectedActorId);
      if (found) return found;
    }
    if (selectedToken) {
      const found = actorsList.find((a) => a.id === selectedToken.id);
      if (found) return found;
    }
    return actorsList[0] ?? null;
  }, [actorsList, selectedActorId, selectedToken]);

  useEffect(() => {
    if (!activeActor) return;
    setEditName(activeActor.name);
    setEditHp(activeActor.hp);
    setEditMaxHp(activeActor.max_hp);
    setEditGmCoreLocked(Boolean(activeActor.gm_core_locked));
    const attrs = activeActor.attributes ?? {};
    setEditAbilities({
      str: Number(attrs.str ?? 10),
      dex: Number(attrs.dex ?? 14),
      con: Number(attrs.con ?? 14),
      int: Number(attrs.int ?? 16),
      wis: Number(attrs.wis ?? 12),
      cha: Number(attrs.cha ?? 10),
    });
    const sh = (activeActor.sheet ?? {}) as Record<string, unknown>;
    setEditClass(String(sh.class ?? 'Wizard'));
    setEditAncestry(String(sh.ancestry ?? 'Elf'));
    setEditLevel(Number(sh.level ?? 1));
    if (Array.isArray(sh.equipment)) {
      setEditEquipment(sh.equipment.map(String));
    }
    if (Array.isArray(sh.spells)) {
      setEditSpells(sh.spells.map(String));
    }
  }, [activeActor?.id, activeActor?.gm_core_locked]);

  const isEffectiveCoreLocked = coreStatsLocked || (!isGm && editGmCoreLocked);

  async function refreshCampaignActors() {
    if (!activeCampaign) return;
    try {
      const refreshed = await apiGetCampaign(activeCampaign.id);
      activeCampaignSignal.value = refreshed;
    } catch {
      // ignore
    }
  }

  async function handleSaveActorSheet(overrides?: {
    level?: number;
    hp?: number;
    maxHp?: number;
    abilities?: Record<AbilityId, number>;
    equipment?: string[];
    spells?: string[];
    gmCoreLocked?: boolean;
    spawnOnMap?: boolean;
  }) {
    if (!activeCampaign) return;
    const actorId = activeActor?.id ?? selectedToken?.id ?? crypto.randomUUID();
    const nextLevel = overrides?.level ?? editLevel;
    const nextHp = overrides?.hp ?? editHp;
    const nextMaxHp = overrides?.maxHp ?? editMaxHp;
    const nextAbilities = overrides?.abilities ?? editAbilities;
    const nextEquipment = overrides?.equipment ?? editEquipment;
    const nextSpells = overrides?.spells ?? editSpells;
    const nextGmLocked = overrides?.gmCoreLocked ?? editGmCoreLocked;

    try {
      await apiUpdateActor(activeCampaign.id, actorId, {
        name: editName,
        hp: nextHp,
        max_hp: nextMaxHp,
        gm_core_locked: isGm ? nextGmLocked : undefined,
        attributes: nextAbilities,
        sheet: {
          class: editClass,
          ancestry: editAncestry,
          level: nextLevel,
          equipment: nextEquipment,
          spells: nextSpells,
        },
        spawn_on_map: overrides?.spawnOnMap ?? false,
      });
      await refreshCampaignActors();
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  }

  async function handleConfirmLevelUp() {
    const nextLevel = Math.min(20, editLevel + 1);
    const hitDie = CLASS_HIT_DIE[editClass] ?? 8;
    const conMod = Math.floor((editAbilities.con - 10) / 2);
    const hpGain =
      levelUpHpMode === 'average'
        ? Math.max(1, Math.floor(hitDie / 2) + 1 + conMod)
        : Math.max(1, Math.floor(Math.random() * hitDie) + 1 + conMod);
    const nextMaxHp = editMaxHp + hpGain;
    const nextHp = editHp + hpGain;
    const nextAbilities = { ...editAbilities };
    if ([4, 8, 12, 16, 19].includes(nextLevel)) {
      nextAbilities[levelUpAsiAbility] = Math.min(20, nextAbilities[levelUpAsiAbility] + 2);
    }
    setEditLevel(nextLevel);
    setEditMaxHp(nextMaxHp);
    setEditHp(nextHp);
    setEditAbilities(nextAbilities);
    setLevelUpOpen(false);
    await handleSaveActorSheet({
      level: nextLevel,
      hp: nextHp,
      maxHp: nextMaxHp,
      abilities: nextAbilities,
    });
  }

  async function handleShortRest() {
    const hitDie = CLASS_HIT_DIE[editClass] ?? 8;
    const conMod = Math.floor((editAbilities.con - 10) / 2);
    const healed = Math.max(1, Math.floor(hitDie / 2) + 1 + conMod);
    const nextHp = Math.min(editMaxHp, editHp + healed);
    setEditHp(nextHp);
    globalWsClient.rollDice(`1d${hitDie}+${conMod}`, 'Public', `${editName} Short Rest Hit Die`);
    await handleSaveActorSheet({ hp: nextHp });
  }

  async function handleLongRest() {
    setEditHp(editMaxHp);
    await handleSaveActorSheet({ hp: editMaxHp });
  }

  async function handleAddCompendiumItem(entry: BilingualCompendiumEntry) {
    if (entry.category === 'spell') {
      const nextSpells = editSpells.includes(entry.nameEn)
        ? editSpells
        : [...editSpells, entry.nameEn];
      setEditSpells(nextSpells);
      await handleSaveActorSheet({ spells: nextSpells });
    } else if (entry.category === 'monster' && isGm) {
      globalWsClient.submitCommand({
        cmd: 'SPAWN_TOKEN',
        token: buildDefaultSpawnTokenPayload({
          id: crypto.randomUUID(),
          name: locale === 'fr' ? entry.nameFr : entry.nameEn,
          owner_user_id: null,
          top_left: { x: 128, y: 128 },
          hp: entry.hp ?? 15,
          max_hp: entry.hp ?? 15,
          visibility_channel: 1,
        }),
      });
    } else {
      const nextEq = editEquipment.includes(entry.nameEn)
        ? editEquipment
        : [...editEquipment, entry.nameEn];
      setEditEquipment(nextEq);
      await handleSaveActorSheet({ equipment: nextEq });
    }
  }

  async function handleCreatePreparedMap(pushToLive: boolean) {
    if (!activeCampaign || !newMapName.trim()) return;
    try {
      const mapId = crypto.randomUUID();
      const res = await apiUpsertMap(activeCampaign.id, mapId, {
        name: newMapName.trim(),
        width_px: newMapWidth,
        height_px: newMapHeight,
        pixels_per_grid: 64,
        revealed_to_players: newMapRevealed,
        push_to_live_table: pushToLive,
      });
      const existing = preparedMapsSignal.value.filter((m) => m.id !== res.map.id);
      preparedMapsSignal.value = [...existing, res.map];
      if (pushToLive) {
        activeWorkspaceTabSignal.value = 'table';
      }
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  }

  async function handlePushPreparedMapToTable(mapId: string, name: string) {
    if (!activeCampaign) return;
    try {
      await apiUpsertMap(activeCampaign.id, mapId, {
        name,
        revealed_to_players: true,
        push_to_live_table: true,
      });
      const updated = await apiListMaps(activeCampaign.id);
      preparedMapsSignal.value = updated.maps;
      activeWorkspaceTabSignal.value = 'table';
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  }

  async function handleSaveJournalNote() {
    if (!activeCampaign) return;
    try {
      const saved = await apiUpsertNote(
        activeCampaign.id,
        selectedNoteSlug,
        noteTitle,
        noteMarkdown,
        noteFolder,
      );
      const rest = wikiNotesSignal.value.filter((n) => n.slug !== saved.slug);
      wikiNotesSignal.value = [...rest, saved];
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  }

  async function handleJournalRevealHandout(handoutId: string, title: string, content: string) {
    if (!activeCampaign) return;
    try {
      await apiRevealHandout(activeCampaign.id, handoutId, title, content);
      const refreshed = await apiListNotes(activeCampaign.id);
      wikiNotesSignal.value = refreshed.notes;
      revealedHandoutsSignal.value = refreshed.handouts;
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  }

  const filteredCompendium = useMemo(
    () =>
      searchBilingualCompendium(
        compendiumQuery,
        compendiumCategory === 'all' ? undefined : compendiumCategory,
      ),
    [compendiumQuery, compendiumCategory],
  );

  const filteredNotes = useMemo(() => {
    if (noteScopeFilter === 'all') return notes;
    return notes.filter((n) => (n.folder ?? 'party') === noteScopeFilter);
  }, [notes, noteScopeFilter]);

  const parsedJournalNote = useMemo(() => {
    const visibleMd = filterWikiMarkdownForRole(noteMarkdown, isGm);
    return parseWikiMarkdown(visibleMd);
  }, [noteMarkdown, isGm]);

  const profBonus = Math.floor((editLevel - 1) / 4) + 2;

  return (
    <div
      data-testid="campaign-workspace"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
        background: '#0b0e14',
        color: '#f8fafc',
      }}
    >
      {/* Top 4-Tab Campaign Navigation Bar */}
      <nav
        data-testid="campaign-workspace-tabs"
        style={{
          height: '2.75rem',
          padding: '0 1rem',
          background: '#111622',
          borderBottom: '1px solid #1e293b',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {(
            [
              {
                id: 'characters',
                icon: '',
                label: t('workspace.tab.characters'),
              },
              {
                id: 'maps',
                icon: '',
                label: isGm ? t('workspace.tab.maps_gm') : t('workspace.tab.maps_player'),
              },
              {
                id: 'documents',
                icon: '',
                label: t('workspace.tab.documents'),
              },
              {
                id: 'table',
                icon: '',
                label: t('workspace.tab.table'),
              },
            ] as const
          ).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`workspace-tab-${tab.id}`}
                onClick={() => {
                  activeWorkspaceTabSignal.value = tab.id;
                }}
                style={{
                  padding: '0.4rem 0.85rem',
                  borderRadius: '6px',
                  border: active ? '1px solid #6366f1' : '1px solid transparent',
                  background: active ? 'rgba(99, 102, 241, 0.22)' : 'transparent',
                  color: active ? '#fff' : '#94a3b8',
                  fontWeight: active ? 700 : 500,
                  fontSize: '0.83rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                }}
              >
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Language (FR/EN) & Distance Unit (ft/m) Switchers */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button
            type="button"
            data-testid="locale-toggle-btn"
            onClick={() => {
              localeSignal.value = locale === 'en' ? 'fr' : 'en';
            }}
            style={{
              padding: '0.25rem 0.55rem',
              borderRadius: '6px',
              border: '1px solid #334155',
              background: '#1e293b',
              color: '#e2e8f0',
              fontSize: '0.75rem',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
             {locale.toUpperCase()}
          </button>

          <button
            type="button"
            data-testid="unit-toggle-btn"
            onClick={() => {
              unitSystemSignal.value = unitSystem === 'imperial_ft' ? 'metric_m' : 'imperial_ft';
            }}
            style={{
              padding: '0.25rem 0.55rem',
              borderRadius: '6px',
              border: '1px solid #334155',
              background: '#1e293b',
              color: '#e2e8f0',
              fontSize: '0.75rem',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
             {unitSystem === 'imperial_ft' ? '5 ft / sq' : '1.5 m / case'}
          </button>
        </div>
      </nav>

      {/* ====================================================================
          TAB 1: CHARACTERS & PARTY HUB (WITH PADLOCK SHEET & LEVEL-UP)
          ==================================================================== */}
      {activeTab === 'characters' && (
        <div
          data-testid="workspace-panel-characters"
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '250px 1fr 320px',
            overflow: 'hidden',
          }}
        >
          {/* Left Column: Party Roster */}
          <aside
            style={{
              borderRight: '1px solid #1e293b',
              background: '#111622',
              padding: '1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.65rem',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Party Roster</h3>
              <button
                type="button"
                data-testid="open-level1-wizard-btn"
                onClick={() => {
                  activeWorkspaceTabSignal.value = 'table';
                  activeDrawerSignal.value = 'wizard';
                }}
                style={{
                  padding: '0.28rem 0.55rem',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#4f46e5',
                  color: '#fff',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                + New Hero
              </button>
            </div>

            {actorsList.map((actor) => {
              const isSelected = activeActor?.id === actor.id;
              const sh = (actor.sheet ?? {}) as Record<string, unknown>;
              return (
                <div
                  key={actor.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  aria-label={`Select character ${actor.name}`}
                  data-testid={`party-actor-card-${actor.id}`}
                  onClick={() => {
                    setSelectedActorId(actor.id);
                    selectedTokenIdSignal.value = actor.id;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedActorId(actor.id);
                      selectedTokenIdSignal.value = actor.id;
                    }
                  }}
                  style={{
                    padding: '0.65rem',
                    borderRadius: '8px',
                    border: isSelected ? '1px solid #6366f1' : '1px solid #1e293b',
                    background: isSelected ? 'rgba(99, 102, 241, 0.16)' : '#0f172a',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: '0.9rem' }}>{actor.name}</strong>
                    {actor.gm_core_locked && (
                      <span title="Core stats locked by GM" style={{ fontSize: '0.75rem', color: '#f59e0b' }}>
                        [GM Lock]
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                    Lvl {Number(sh.level ?? 1)} {String(sh.ancestry ?? 'Elf')} {String(sh.class ?? 'Wizard')} • HP{' '}
                    {actor.hp}/{actor.max_hp}
                  </div>
                </div>
              );
            })}
          </aside>

          {/* Center Column: Padlock-Protected Character Sheet */}
          <main
            style={{
              padding: '1.25rem',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
            }}
          >
            {/* Header Bar with Padlock, GM Core Lock, Level-Up, Short/Long Rest */}
            <div
              style={{
                background: '#131722',
                border: '1px solid #1e293b',
                borderRadius: '10px',
                padding: '0.9rem 1.1rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '0.75rem',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    aria-label="Character Name"
                    type="text"
                    data-testid="hub-actor-name-input"
                    disabled={isEffectiveCoreLocked}
                    value={editName}
                    onInput={(e) => setEditName((e.currentTarget as HTMLInputElement).value)}
                    style={{
                      fontSize: '1.2rem',
                      fontWeight: 800,
                      background: isEffectiveCoreLocked ? 'transparent' : '#0f172a',
                      border: isEffectiveCoreLocked ? '1px solid transparent' : '1px solid #f59e0b',
                      borderRadius: '6px',
                      color: '#f8fafc',
                      padding: '0.2rem 0.4rem',
                    }}
                  />
                  <span
                    data-testid="hub-actor-level-badge"
                    style={{
                      padding: '0.2rem 0.55rem',
                      borderRadius: '999px',
                      background: 'rgba(99, 102, 241, 0.2)',
                      color: '#a5b4fc',
                      fontWeight: 700,
                      fontSize: '0.78rem',
                    }}
                  >
                    Level {editLevel} {editAncestry} {editClass} (Prof +{profBonus})
                  </span>
                </div>
                <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: '0.2rem' }}>
                  Speed: {formatDistanceFt(30, true)} • Hit Die: 1d{CLASS_HIT_DIE[editClass] ?? 8}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  data-testid="hub-sheet-lock-toggle-btn"
                  disabled={!isGm && editGmCoreLocked}
                  onClick={() => {
                    coreStatsLockedSignal.value = !coreStatsLocked;
                  }}
                  style={{
                    padding: '0.4rem 0.75rem',
                    borderRadius: '6px',
                    border: isEffectiveCoreLocked ? '1px solid #475569' : '1px solid #f59e0b',
                    background: isEffectiveCoreLocked ? '#1e293b' : 'rgba(245, 158, 11, 0.2)',
                    color: isEffectiveCoreLocked ? '#cbd5e1' : '#fcd34d',
                    fontWeight: 700,
                    fontSize: '0.8rem',
                    cursor: !isGm && editGmCoreLocked ? 'not-allowed' : 'pointer',
                  }}
                >
                  {!isGm && editGmCoreLocked
                    ? ` ${t('sheet.gm_locked')}`
                    : isEffectiveCoreLocked
                      ? ` ${t('sheet.locked')}`
                      : ` ${t('sheet.unlocked')}`}
                </button>

                {isGm && (
                  <button
                    type="button"
                    data-testid="gm-core-lock-toggle-btn"
                    onClick={() => {
                      const next = !editGmCoreLocked;
                      setEditGmCoreLocked(next);
                      void handleSaveActorSheet({ gmCoreLocked: next });
                    }}
                    style={{
                      padding: '0.4rem 0.7rem',
                      borderRadius: '6px',
                      border: editGmCoreLocked ? '1px solid #f59e0b' : '1px solid #334155',
                      background: editGmCoreLocked ? 'rgba(245, 158, 11, 0.22)' : '#0f172a',
                      color: editGmCoreLocked ? '#fde68a' : '#94a3b8',
                      fontWeight: 700,
                      fontSize: '0.78rem',
                      cursor: 'pointer',
                    }}
                  >
                    {editGmCoreLocked ? ' GM Core Locked' : ' Lock Player Build'}
                  </button>
                )}

                <button
                  type="button"
                  data-testid="open-level-up-modal-btn"
                  disabled={!isGm && editGmCoreLocked}
                  onClick={() => setLevelUpOpen(true)}
                  style={{
                    padding: '0.4rem 0.75rem',
                    borderRadius: '6px',
                    border: 'none',
                    background: '#4f46e5',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  {t('sheet.level_up')}
                </button>

                <button
                  type="button"
                  data-testid="short-rest-btn"
                  onClick={handleShortRest}
                  style={{
                    padding: '0.4rem 0.65rem',
                    borderRadius: '6px',
                    border: '1px solid #38bdf8',
                    background: 'rgba(56, 189, 248, 0.14)',
                    color: '#7dd3fc',
                    fontWeight: 600,
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                  }}
                >
                   {t('sheet.short_rest')}
                </button>

                <button
                  type="button"
                  data-testid="long-rest-btn"
                  onClick={handleLongRest}
                  style={{
                    padding: '0.4rem 0.65rem',
                    borderRadius: '6px',
                    border: '1px solid #10b981',
                    background: 'rgba(16, 185, 129, 0.14)',
                    color: '#6ee7b7',
                    fontWeight: 600,
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                  }}
                >
                   {t('sheet.long_rest')}
                </button>

                <button
                  type="button"
                  data-testid="hub-save-actor-btn"
                  onClick={() => void handleSaveActorSheet()}
                  style={{
                    padding: '0.4rem 0.8rem',
                    borderRadius: '6px',
                    border: 'none',
                    background: '#10b981',
                    color: '#052e16',
                    fontWeight: 800,
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  Save Changes
                </button>
              </div>
            </div>

            {/* Always-unlocked Live Play Resources (HP, Temp HP, Send to Table) */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '0.75rem',
              }}
            >
              <div style={{ background: '#131722', border: '1px solid #1e293b', borderRadius: '8px', padding: '0.75rem' }}>
                <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 700 }}>CURRENT / MAX HP (ALWAYS UNLOCKED)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.35rem' }}>
                  <input
                    aria-label="Current HP"
                    type="number"
                    data-testid="hub-actor-hp-input"
                    value={editHp}
                    onInput={(e) => setEditHp(Number((e.currentTarget as HTMLInputElement).value) || 0)}
                    style={{
                      width: '4rem',
                      padding: '0.3rem',
                      borderRadius: '6px',
                      border: '1px solid #334155',
                      background: '#0f172a',
                      color: '#4ade80',
                      fontWeight: 800,
                      textAlign: 'center',
                    }}
                  />
                  <span>/</span>
                  <input
                    aria-label="Maximum HP"
                    type="number"
                    data-testid="hub-actor-maxhp-input"
                    disabled={isEffectiveCoreLocked}
                    value={editMaxHp}
                    onInput={(e) => setEditMaxHp(Number((e.currentTarget as HTMLInputElement).value) || 1)}
                    style={{
                      width: '4rem',
                      padding: '0.3rem',
                      borderRadius: '6px',
                      border: isEffectiveCoreLocked ? '1px solid transparent' : '1px solid #f59e0b',
                      background: '#0f172a',
                      color: '#f8fafc',
                      fontWeight: 700,
                      textAlign: 'center',
                    }}
                  />
                </div>
              </div>

              <div style={{ background: '#131722', border: '1px solid #1e293b', borderRadius: '8px', padding: '0.75rem' }}>
                <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 700 }}>ARMOR CLASS & INITIATIVE</div>
                <div style={{ fontSize: '1.15rem', fontWeight: 800, marginTop: '0.35rem' }}>
                  AC {10 + Math.floor((editAbilities.dex - 10) / 2)} • Init{' '}
                  {Math.floor((editAbilities.dex - 10) / 2) >= 0
                    ? `+${Math.floor((editAbilities.dex - 10) / 2)}`
                    : Math.floor((editAbilities.dex - 10) / 2)}
                </div>
              </div>

              <div style={{ background: '#131722', border: '1px solid #1e293b', borderRadius: '8px', padding: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 700 }}>TABLETOP TOKEN</div>
                  <div style={{ fontSize: '0.8rem', color: '#cbd5e1', marginTop: '0.2rem' }}>
                    {tableState?.tokens[activeActor?.id ?? ''] ? 'Active on Live Map' : 'Not yet on map'}
                  </div>
                </div>
                {isGm && (
                  <button
                    type="button"
                    data-testid="spawn-actor-on-table-btn"
                    onClick={() => void handleSaveActorSheet({ spawnOnMap: true })}
                    style={{
                      padding: '0.35rem 0.65rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: '#2563eb',
                      color: '#fff',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Place on Map
                  </button>
                )}
              </div>
            </div>

            {/* 6 Core Ability Scores (Padlock Protected) */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(6, 1fr)',
                gap: '0.6rem',
              }}
            >
              {DND5E_ABILITIES.map((ab) => {
                const score = editAbilities[ab];
                const mod = Math.floor((score - 10) / 2);
                const modStr = mod >= 0 ? `+${mod}` : `${mod}`;
                return (
                  <div
                    key={ab}
                    data-testid={`hub-ability-card-${ab}`}
                    style={{
                      background: '#131722',
                      border: isEffectiveCoreLocked ? '1px solid #1e293b' : '1px solid #f59e0b',
                      borderRadius: '8px',
                      padding: '0.65rem 0.45rem',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.3rem',
                    }}
                  >
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8' }}>
                      {t(`ability.${ab}`)}
                    </span>
                    <input
                      aria-label={`${ab.toUpperCase()} Ability Score`}
                      type="number"
                      min={1}
                      max={30}
                      disabled={isEffectiveCoreLocked}
                      readOnly={isEffectiveCoreLocked}
                      data-testid={`hub-ability-input-${ab}`}
                      value={score}
                      onInput={(e) => {
                        if (isEffectiveCoreLocked) return;
                        const val = Number((e.currentTarget as HTMLInputElement).value) || 10;
                        setEditAbilities((prev) => ({ ...prev, [ab]: val }));
                      }}
                      style={{
                        width: '3.2rem',
                        textAlign: 'center',
                        background: isEffectiveCoreLocked ? 'transparent' : '#0f172a',
                        border: isEffectiveCoreLocked ? '1px solid transparent' : '1px solid #f59e0b',
                        borderRadius: '4px',
                        color: '#f8fafc',
                        fontSize: '1.05rem',
                        fontWeight: 800,
                      }}
                    />
                    <button
                      type="button"
                      data-testid={`hub-ability-roll-${ab}`}
                      onClick={() => {
                        const expr = mod >= 0 ? `1d20+${mod}` : `1d20${mod}`;
                        globalWsClient.rollDice(expr, 'Public', `${editName} ${ab.toUpperCase()} Check`);
                      }}
                      style={{
                        padding: '0.25rem 0.55rem',
                        borderRadius: '4px',
                        border: 'none',
                        background: 'rgba(99, 102, 241, 0.2)',
                        color: '#a5b4fc',
                        fontWeight: 700,
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                      }}
                    >
                       {modStr}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Inventory & Spells Lists */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem' }}>
              <div style={{ background: '#131722', border: '1px solid #1e293b', borderRadius: '8px', padding: '0.85rem' }}>
                <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.88rem', color: '#cbd5e1' }}>
                   Equipped Gear & Containers ({editEquipment.length})
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {editEquipment.map((item, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '0.4rem 0.6rem',
                        background: '#0f172a',
                        borderRadius: '6px',
                        fontSize: '0.82rem',
                        display: 'flex',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>{item}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setEditEquipment((prev) => prev.filter((_, i) => i !== idx))
                        }
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#64748b',
                          cursor: 'pointer',
                          fontSize: '0.75rem',
                        }}
                      >
                        
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ background: '#131722', border: '1px solid #1e293b', borderRadius: '8px', padding: '0.85rem' }}>
                <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.88rem', color: '#cbd5e1' }}>
                   Prepared Spells & Grimoire ({editSpells.length})
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {editSpells.map((spell, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '0.4rem 0.6rem',
                        background: '#0f172a',
                        borderRadius: '6px',
                        fontSize: '0.82rem',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span>{spell}</span>
                      <button
                        type="button"
                        onClick={() => {
                          globalWsClient.rollDice('8d6', 'Public', `${editName} casts ${spell}`);
                        }}
                        style={{
                          padding: '0.15rem 0.45rem',
                          borderRadius: '4px',
                          border: 'none',
                          background: 'rgba(56, 189, 248, 0.16)',
                          color: '#38bdf8',
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        Cast
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </main>

          {/* Right Column: Bilingual SRD 5.1 Compendium Browser */}
          <aside
            data-testid="compendium-browser-drawer"
            style={{
              borderLeft: '1px solid #1e293b',
              background: '#111622',
              padding: '1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.65rem',
              overflowY: 'auto',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '0.95rem' }}>
               SRD 5.1 Compendium (FR / EN)
            </h3>
            <input
              aria-label="Search SRD Compendium"
              type="text"
              data-testid="compendium-search-input"
              value={compendiumQuery}
              onInput={(e) => setCompendiumQuery((e.currentTarget as HTMLInputElement).value)}
              placeholder="Search Fireball, Boule de feu, Goblin..."
              style={{
                padding: '0.45rem 0.65rem',
                borderRadius: '6px',
                border: '1px solid #334155',
                background: '#0f172a',
                color: '#f8fafc',
                fontSize: '0.82rem',
              }}
            />
            <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
              {(['all', 'weapon', 'spell', 'container', 'feat', 'monster'] as const).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCompendiumCategory(cat)}
                  style={{
                    padding: '0.2rem 0.45rem',
                    borderRadius: '4px',
                    border: compendiumCategory === cat ? '1px solid #6366f1' : '1px solid #334155',
                    background: compendiumCategory === cat ? 'rgba(99, 102, 241, 0.2)' : '#0f172a',
                    color: '#e2e8f0',
                    fontSize: '0.72rem',
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
              {filteredCompendium.map((entry) => (
                <div
                  key={entry.id}
                  data-testid={`compendium-item-${entry.id}`}
                  style={{
                    padding: '0.55rem 0.65rem',
                    borderRadius: '8px',
                    background: '#0f172a',
                    border: '1px solid #1e293b',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: '0.84rem', color: '#f8fafc' }}>
                      {locale === 'fr' ? `${entry.nameFr} (${entry.nameEn})` : `${entry.nameEn} (${entry.nameFr})`}
                    </strong>
                    <button
                      type="button"
                      data-testid={`compendium-add-${entry.id}`}
                      onClick={() => void handleAddCompendiumItem(entry)}
                      style={{
                        padding: '0.18rem 0.45rem',
                        borderRadius: '4px',
                        border: 'none',
                        background: '#4f46e5',
                        color: '#fff',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      {entry.category === 'monster' && isGm ? '+ Spawn' : '+ Add'}
                    </button>
                  </div>
                  <div style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
                    {locale === 'fr' ? entry.summaryFr : entry.summaryEn}
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}

      {/* ====================================================================
          TAB 2: GM MAP PREP STUDIO / PLAYER REVEALED SCENE ATLAS
          ==================================================================== */}
      {activeTab === 'maps' && (
        <div
          data-testid="workspace-panel-maps"
          style={{
            flex: 1,
            padding: '1.25rem',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.1rem',
          }}
        >
          {isGm ? (
            <div
              data-testid="gm-map-prep-studio"
              style={{
                background: '#131722',
                border: '1px solid #1e293b',
                borderRadius: '10px',
                padding: '1rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.85rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.05rem' }}> GM Map Preparation Studio</h3>
                  <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>
                    Prepare battlemaps ahead of session, import `.uvtt` dynamic lighting walls, or push any scene to the Live Table.
                  </p>
                </div>

                {/* Combat Automation Mode Selector */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                  <label htmlFor="combat-automation-mode-select" style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>Combat Rules:</label>
                  <select
                    id="combat-automation-mode-select"
                    aria-label="Combat Automation Mode"
                    data-testid="combat-automation-mode-select"
                    value={automationMode}
                    onChange={(e) => {
                      combatAutomationModeSignal.value = (e.currentTarget as HTMLSelectElement)
                        .value as CombatAutomationMode;
                    }}
                    style={{
                      padding: '0.35rem 0.6rem',
                      borderRadius: '6px',
                      border: '1px solid #334155',
                      background: '#0f172a',
                      color: '#f8fafc',
                      fontSize: '0.8rem',
                    }}
                  >
                    <option value="ASSISTED_DM_CONFIRM">Assisted Roll + DM Confirm (Recommended)</option>
                    <option value="FULL_AUTOMATION">Full Automation (Auto-Apply Damage)</option>
                    <option value="MANUAL_CLASSIC">Manual Classic Dice Tray</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <label htmlFor="prep-map-name-input" style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.2rem' }}>
                    Scene Name
                  </label>
                  <input
                    id="prep-map-name-input"
                    aria-label="Scene Name"
                    type="text"
                    data-testid="prep-map-name-input"
                    value={newMapName}
                    onInput={(e) => setNewMapName((e.currentTarget as HTMLInputElement).value)}
                    style={{
                      padding: '0.45rem 0.65rem',
                      borderRadius: '6px',
                      border: '1px solid #334155',
                      background: '#0f172a',
                      color: '#f8fafc',
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.2rem' }}>
                    Dimensions (px)
                  </label>
                  <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                    <input
                      aria-label="Map Width in Pixels"
                      type="number"
                      value={newMapWidth}
                      onInput={(e) => setNewMapWidth(Number((e.currentTarget as HTMLInputElement).value) || 1200)}
                      style={{ width: '5rem', padding: '0.45rem', borderRadius: '6px', border: '1px solid #334155', background: '#0f172a', color: '#fff' }}
                    />
                    <span>×</span>
                    <input
                      aria-label="Map Height in Pixels"
                      type="number"
                      value={newMapHeight}
                      onInput={(e) => setNewMapHeight(Number((e.currentTarget as HTMLInputElement).value) || 800)}
                      style={{ width: '5rem', padding: '0.45rem', borderRadius: '6px', border: '1px solid #334155', background: '#0f172a', color: '#fff' }}
                    />
                  </div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem', cursor: 'pointer', paddingBottom: '0.35rem' }}>
                  <input
                    type="checkbox"
                    checked={newMapRevealed}
                    onChange={(e) => setNewMapRevealed((e.currentTarget as HTMLInputElement).checked)}
                  />
                  Visible in Player Atlas
                </label>

                <button
                  type="button"
                  data-testid="save-prepared-map-btn"
                  onClick={() => void handleCreatePreparedMap(false)}
                  style={{
                    padding: '0.45rem 0.85rem',
                    borderRadius: '6px',
                    border: '1px solid #6366f1',
                    background: 'rgba(99, 102, 241, 0.2)',
                    color: '#c7d2fe',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Save to Prep Library
                </button>

                <button
                  type="button"
                  data-testid="save-and-push-map-btn"
                  onClick={() => void handleCreatePreparedMap(true)}
                  style={{
                    padding: '0.45rem 0.85rem',
                    borderRadius: '6px',
                    border: 'none',
                    background: '#10b981',
                    color: '#052e16',
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  Push to Live Table →
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    if (!activeCampaign) return;
                    await apiGenerateStarterMap(activeCampaign.id);
                    const updated = await apiListMaps(activeCampaign.id);
                    preparedMapsSignal.value = updated.maps;
                    activeWorkspaceTabSignal.value = 'table';
                  }}
                  style={{
                    padding: '0.45rem 0.85rem',
                    borderRadius: '6px',
                    border: '1px solid #10b981',
                    background: 'rgba(16, 185, 129, 0.16)',
                    color: '#6ee7b7',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Generate Starter Dungeon
                </button>

                <label
                  style={{
                    padding: '0.45rem 0.85rem',
                    borderRadius: '6px',
                    border: '1px solid #475569',
                    background: '#1e293b',
                    color: '#e2e8f0',
                    fontSize: '0.82rem',
                    cursor: 'pointer',
                  }}
                >
                  Import .uvtt Battlemap
                  <input
                    type="file"
                    accept=".uvtt,.dd2vtt,application/json"
                    onChange={async (e) => {
                      const file = (e.currentTarget as HTMLInputElement).files?.[0];
                      if (!file || !activeCampaign) return;
                      const buf = await file.arrayBuffer();
                      await apiUploadUvttMap(activeCampaign.id, buf);
                      const updated = await apiListMaps(activeCampaign.id);
                      preparedMapsSignal.value = updated.maps;
                      activeWorkspaceTabSignal.value = 'table';
                    }}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>
            </div>
          ) : (
            <div
              data-testid="player-scene-atlas-header"
              style={{
                background: '#131722',
                border: '1px solid #1e293b',
                borderRadius: '10px',
                padding: '1rem',
              }}
            >
              <h3 style={{ margin: 0, fontSize: '1.05rem' }}> Revealed Campaign Atlas</h3>
              <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.82rem', color: '#94a3b8' }}>
                Locations and battlemaps discovered by the party during the campaign.
              </p>
            </div>
          )}

          {/* Grid of Prepared / Revealed Maps */}
          <div
            data-testid="prepared-maps-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: '0.85rem',
            }}
          >
            {preparedMaps.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '0.88rem' }}>
                No maps registered yet.
              </div>
            ) : (
              preparedMaps.map((m) => (
                <div
                  key={m.id}
                  data-testid={`prepared-map-card-${m.id}`}
                  style={{
                    background: '#131722',
                    border: '1px solid #1e293b',
                    borderRadius: '10px',
                    padding: '0.9rem',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    gap: '0.6rem',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{m.name}</div>
                    <div style={{ fontSize: '0.76rem', color: '#94a3b8', marginTop: '0.2rem' }}>
                      {m.width_px}×{m.height_px} px • Grid {m.pixels_per_grid}px
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span
                      style={{
                        fontSize: '0.72rem',
                        padding: '0.15rem 0.45rem',
                        borderRadius: '999px',
                        background: m.revealed_to_players !== false ? 'rgba(16, 185, 129, 0.16)' : 'rgba(245, 158, 11, 0.16)',
                        color: m.revealed_to_players !== false ? '#6ee7b7' : '#fcd34d',
                      }}
                    >
                      {m.revealed_to_players !== false ? 'Revealed to Party' : 'GM Prep Only'}
                    </span>
                    {isGm && (
                      <button
                        type="button"
                        data-testid={`activate-map-btn-${m.id}`}
                        onClick={() => void handlePushPreparedMapToTable(m.id, m.name)}
                        style={{
                          padding: '0.3rem 0.65rem',
                          borderRadius: '6px',
                          border: 'none',
                          background: '#4f46e5',
                          color: '#fff',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        Push to Table
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ====================================================================
          TAB 3: JOURNAL & PAST DOCUMENTS (3-SCOPE NOTES & HANDOUT ARCHIVE)
          ==================================================================== */}
      {activeTab === 'documents' && (
        <div
          data-testid="workspace-panel-documents"
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '280px 1fr 340px',
            overflow: 'hidden',
          }}
        >
          {/* Left: Note Scope Filter & List */}
          <aside
            style={{
              borderRight: '1px solid #1e293b',
              background: '#111622',
              padding: '1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.65rem',
              overflowY: 'auto',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '0.95rem' }}> Campaign Journal</h3>
            <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
              {(['all', 'party', 'private', ...(isGm ? (['dm_only'] as const) : [])] as const).map((sc) => (
                <button
                  key={sc}
                  type="button"
                  data-testid={`note-scope-filter-${sc}`}
                  onClick={() => setNoteScopeFilter(sc as 'all' | 'private' | 'party' | 'dm_only')}
                  style={{
                    padding: '0.22rem 0.5rem',
                    borderRadius: '4px',
                    border: noteScopeFilter === sc ? '1px solid #6366f1' : '1px solid #334155',
                    background: noteScopeFilter === sc ? 'rgba(99, 102, 241, 0.22)' : '#0f172a',
                    color: '#e2e8f0',
                    fontSize: '0.73rem',
                    cursor: 'pointer',
                  }}
                >
                  {sc === 'dm_only' ? 'GM Only' : sc.toUpperCase()}
                </button>
              ))}
            </div>

            {filteredNotes.map((n) => (
              <button
                key={n.slug}
                type="button"
                data-testid={`journal-note-item-${n.slug}`}
                onClick={() => {
                  setSelectedNoteSlug(n.slug);
                  setNoteTitle(n.title);
                  setNoteMarkdown(n.content_markdown);
                  setNoteFolder((n.folder as 'private' | 'party' | 'dm_only') || 'party');
                }}
                style={{
                  textAlign: 'left',
                  padding: '0.55rem 0.65rem',
                  borderRadius: '8px',
                  border: selectedNoteSlug === n.slug ? '1px solid #6366f1' : '1px solid #1e293b',
                  background: '#0f172a',
                  color: '#f8fafc',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: '0.84rem' }}>{n.title}</div>
                <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                  Scope: {(n.folder ?? 'party').toUpperCase()}
                </div>
              </button>
            ))}
          </aside>

          {/* Center: Collaborative Note Editor & Role-Filtered Preview */}
          <main
            style={{
              padding: '1.25rem',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85rem',
            }}
          >
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                aria-label="Journal Note Title"
                type="text"
                data-testid="journal-note-title-input"
                value={noteTitle}
                onInput={(e) => setNoteTitle((e.currentTarget as HTMLInputElement).value)}
                style={{
                  flex: 1,
                  padding: '0.5rem 0.75rem',
                  borderRadius: '6px',
                  border: '1px solid #334155',
                  background: '#0f172a',
                  color: '#f8fafc',
                  fontWeight: 700,
                }}
              />
              <select
                aria-label="Journal Note Visibility Scope"
                data-testid="journal-note-scope-select"
                value={noteFolder}
                onChange={(e) =>
                  setNoteFolder(
                    (e.currentTarget as HTMLSelectElement).value as 'private' | 'party' | 'dm_only',
                  )
                }
                style={{
                  padding: '0.5rem',
                  borderRadius: '6px',
                  border: '1px solid #334155',
                  background: '#0f172a',
                  color: '#f8fafc',
                }}
              >
                <option value="party">Shared Party Journal</option>
                <option value="private">Private Personal Note</option>
                {isGm && <option value="dm_only">GM Secret Lore (DM_ONLY)</option>}
              </select>
              <button
                type="button"
                data-testid="journal-save-note-btn"
                onClick={() => void handleSaveJournalNote()}
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
                Save Note
              </button>
            </div>

            <textarea
              aria-label="Journal Note Markdown Content"
              rows={6}
              data-testid="journal-note-markdown-input"
              value={noteMarkdown}
              onInput={(e) => setNoteMarkdown((e.currentTarget as HTMLTextAreaElement).value)}
              style={{
                padding: '0.65rem',
                borderRadius: '8px',
                border: '1px solid #334155',
                background: '#0f172a',
                color: '#e2e8f0',
                fontFamily: 'monospace',
                fontSize: '0.82rem',
              }}
            />

            <div
              data-testid="journal-rendered-preview"
              style={{
                background: '#131722',
                border: '1px solid #1e293b',
                borderRadius: '8px',
                padding: '0.9rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.6rem',
              }}
            >
              {parsedJournalNote.ast.map((node, idx) => {
                if (node.type === 'text') {
                  return (
                    <div key={idx} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                      {node.content}
                    </div>
                  );
                }
                if (node.type === 'dm') {
                  return (
                    <div
                      key={idx}
                      style={{
                        padding: '0.5rem 0.7rem',
                        borderRadius: '6px',
                        background: 'rgba(245, 158, 11, 0.15)',
                        borderLeft: '3px solid #f59e0b',
                        color: '#fde68a',
                      }}
                    >
                      <strong>GM Secret:</strong> {node.content}
                    </div>
                  );
                }
                if (node.type === 'handout') {
                  return (
                    <div
                      key={idx}
                      style={{
                        padding: '0.6rem 0.75rem',
                        borderRadius: '6px',
                        background: 'rgba(56, 189, 248, 0.12)',
                        border: '1px solid #0284c7',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <strong style={{ color: '#7dd3fc' }}> {node.title}</strong>
                        <div style={{ fontSize: '0.82rem', marginTop: '0.2rem' }}>{node.content}</div>
                      </div>
                      {isGm && (
                        <button
                          type="button"
                          data-testid={`journal-reveal-handout-${node.id}`}
                          onClick={() => void handleJournalRevealHandout(node.id, node.title, node.content)}
                          style={{
                            padding: '0.3rem 0.65rem',
                            borderRadius: '6px',
                            border: 'none',
                            background: '#0284c7',
                            color: '#fff',
                            fontWeight: 700,
                            fontSize: '0.75rem',
                            cursor: 'pointer',
                          }}
                        >
                          Broadcast to Players
                        </button>
                      )}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </main>

          {/* Right: Revealed Handouts Archive Gallery */}
          <aside
            data-testid="handouts-archive-gallery"
            style={{
              borderLeft: '1px solid #1e293b',
              background: '#111622',
              padding: '1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.65rem',
              overflowY: 'auto',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '0.95rem' }}> Revealed Handouts Archive</h3>
            {handouts.length === 0 ? (
              <p style={{ color: '#64748b', fontSize: '0.82rem' }}>
                No handouts revealed yet. When the GM reveals a document or clue, it appears here permanently.
              </p>
            ) : (
              handouts.map((h, i) => (
                <div
                  key={i}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open revealed handout ${h.title}`}
                  data-testid={`archived-handout-${h.handout_id}`}
                  onClick={() => {
                    activeHandoutModalSignal.value = h;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      activeHandoutModalSignal.value = h;
                    }
                  }}
                  style={{
                    padding: '0.65rem',
                    borderRadius: '8px',
                    background: '#0f172a',
                    border: '1px solid #10b981',
                    cursor: 'pointer',
                  }}
                >
                  <strong style={{ color: '#6ee7b7', fontSize: '0.86rem' }}>{h.title}</strong>
                  <div style={{ fontSize: '0.78rem', color: '#cbd5e1', marginTop: '0.25rem' }}>
                    {h.content}
                  </div>
                </div>
              ))
            )}
          </aside>
        </div>
      )}

      {/* ====================================================================
          TAB 4: LIVE TABLE (CANVAS + RIGHT-CLICK + HUD DRAWERS)
          ==================================================================== */}
      {activeTab === 'table' && (
        <main style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
          <TableCanvas />
          <HudDrawers />
        </main>
      )}

      {/* ====================================================================
          MODAL: D&D 5E LEVEL-UP WIZARD (LEVELS 1 -> 20)
          ==================================================================== */}
      {levelUpOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="level-up-modal-title"
          tabIndex={-1}
          data-testid="level-up-modal"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setLevelUpOpen(false);
            }
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(2, 6, 23, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            style={{
              width: '440px',
              maxWidth: '92vw',
              background: '#131722',
              border: '1px solid #4f46e5',
              borderRadius: '12px',
              padding: '1.25rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.9rem',
            }}
          >
            <h3 id="level-up-modal-title" style={{ margin: 0, fontSize: '1.1rem' }}>
              Level Up {editName}: Level {editLevel} to Level {Math.min(20, editLevel + 1)}
            </h3>
            <div style={{ fontSize: '0.84rem', color: '#cbd5e1' }}>
              Class: <strong>{editClass}</strong> (Hit Die: 1d{CLASS_HIT_DIE[editClass] ?? 8})
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                data-testid="levelup-hp-average-btn"
                onClick={() => setLevelUpHpMode('average')}
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  borderRadius: '6px',
                  border: levelUpHpMode === 'average' ? '1px solid #6366f1' : '1px solid #334155',
                  background: levelUpHpMode === 'average' ? 'rgba(99, 102, 241, 0.22)' : '#0f172a',
                  color: '#f8fafc',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Fixed Average HP (+
                {Math.max(
                  1,
                  Math.floor((CLASS_HIT_DIE[editClass] ?? 8) / 2) +
                    1 +
                    Math.floor((editAbilities.con - 10) / 2),
                )}
                )
              </button>
              <button
                type="button"
                data-testid="levelup-hp-roll-btn"
                onClick={() => setLevelUpHpMode('roll')}
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  borderRadius: '6px',
                  border: levelUpHpMode === 'roll' ? '1px solid #6366f1' : '1px solid #334155',
                  background: levelUpHpMode === 'roll' ? 'rgba(99, 102, 241, 0.22)' : '#0f172a',
                  color: '#f8fafc',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Roll 1d{CLASS_HIT_DIE[editClass] ?? 8} + CON
              </button>
            </div>

            {[4, 8, 12, 16, 19].includes(editLevel + 1) && (
              <div>
                <label htmlFor="levelup-asi-select" style={{ fontSize: '0.8rem', color: '#fde68a', display: 'block', marginBottom: '0.3rem' }}>
                  Ability Score Improvement (+2 at Level {editLevel + 1}):
                </label>
                <select
                  id="levelup-asi-select"
                  aria-label="Ability Score Improvement"
                  data-testid="levelup-asi-select"
                  value={levelUpAsiAbility}
                  onChange={(e) =>
                    setLevelUpAsiAbility((e.currentTarget as HTMLSelectElement).value as AbilityId)
                  }
                  style={{
                    width: '100%',
                    padding: '0.45rem',
                    borderRadius: '6px',
                    border: '1px solid #334155',
                    background: '#0f172a',
                    color: '#fff',
                  }}
                >
                  {DND5E_ABILITIES.map((ab) => (
                    <option key={ab} value={ab}>
                      +2 {ab.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                type="button"
                onClick={() => setLevelUpOpen(false)}
                style={{
                  padding: '0.45rem 0.85rem',
                  borderRadius: '6px',
                  border: '1px solid #334155',
                  background: '#1e293b',
                  color: '#cbd5e1',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-level-up-btn"
                onClick={() => void handleConfirmLevelUp()}
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
                Confirm Level {Math.min(20, editLevel + 1)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          LIVE HANDOUT REVEAL POPUP MODAL (WEBSOCKET BROADCAST)
          ==================================================================== */}
      {activeHandoutModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="live-handout-modal-title"
          tabIndex={-1}
          data-testid="live-handout-modal"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              activeHandoutModalSignal.value = null;
            }
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(2, 6, 23, 0.82)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 110,
          }}
        >
          <div
            style={{
              width: '480px',
              maxWidth: '92vw',
              background: '#131722',
              border: '2px solid #0284c7',
              borderRadius: '12px',
              padding: '1.35rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 id="live-handout-modal-title" style={{ margin: 0, color: '#7dd3fc', fontSize: '1.15rem' }}>
                Handout Revealed: {activeHandoutModal.title}
              </h3>
              <button
                type="button"
                data-testid="close-handout-modal-btn"
                onClick={() => {
                  activeHandoutModalSignal.value = null;
                }}
                style={{
                  padding: '0.25rem 0.6rem',
                  borderRadius: '6px',
                  border: '1px solid #334155',
                  background: '#1e293b',
                  color: '#e2e8f0',
                  cursor: 'pointer',
                }}
              >
                Dismiss
              </button>
            </div>
            <div
              data-testid="live-handout-modal-content"
              style={{
                padding: '0.85rem',
                borderRadius: '8px',
                background: '#0f172a',
                color: '#f8fafc',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
              }}
            >
              {activeHandoutModal.content}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
