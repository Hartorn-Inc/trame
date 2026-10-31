/**
 * ============================================================================
 * REACTIVE BILINGUAL (FR/EN) & METRIC/IMPERIAL UNIT SYSTEM (i18n/index.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Implements the 4-layer TRAME localization and tactical distance formatting
 * architecture:
 *   1. Layer 1 (Wire/Engine): Canonical English/ASCII slugs (`str..cha`,
 *      `stealth`, `srd:spell:fireball`, internal distance in `feet`).
 *   2. Layer 2 (UI Chrome & Sheet): Reactive `localeSignal` (`'en' | 'fr'`)
 *      translating workspace tabs, right-click menus, and D&D 5e terms.
 *   3. Layer 3 (Bilingual Compendium): Dual-index search matching both
 *      French (VF) and English (VO) names simultaneously.
 *   4. Layer 4 (Tactical Units): `unitSystemSignal` (`'imperial_ft' | 'metric_m'`)
 *      formatting distances as `30 ft (6 sq)` or `9 m (6 cases)` (`5 ft = 1.5 m`).
 * ============================================================================
 */

import { signal } from '@preact/signals';

export type SupportedLocale = 'en' | 'fr';
export type UnitSystem = 'imperial_ft' | 'metric_m';

export const localeSignal = signal<SupportedLocale>('en');
export const unitSystemSignal = signal<UnitSystem>('imperial_ft');

const DICTIONARY: Record<SupportedLocale, Record<string, string>> = {
  en: {
    'workspace.tab.characters': 'Characters & Party',
    'workspace.tab.maps_gm': 'Maps & Prep Studio',
    'workspace.tab.maps_player': 'Revealed Atlas',
    'workspace.tab.documents': 'Journal & Documents',
    'workspace.tab.table': 'Live Table',
    'sheet.locked': 'Stats Locked (Click to Roll)',
    'sheet.unlocked': 'Edit Mode (Unlocked)',
    'sheet.gm_locked': 'Locked by GM',
    'sheet.level_up': '⬆ Level Up',
    'sheet.short_rest': 'Short Rest',
    'sheet.long_rest': 'Long Rest',
    'ability.str': 'STR',
    'ability.dex': 'DEX',
    'ability.con': 'CON',
    'ability.int': 'INT',
    'ability.wis': 'WIS',
    'ability.cha': 'CHA',
    'menu.move_here': 'Move Selected Token Here',
    'menu.cast_aoe': 'Cast AoE Sphere (20 ft)',
    'menu.ping_here': 'Ping Here',
    'menu.gm_teleport': 'GM Teleport Selected Here',
    'menu.gm_spawn_monster': 'GM: Spawn Monster Here',
    'menu.attack_melee': 'Melee Attack Target',
    'menu.damage_5': 'Apply 5 Damage',
    'menu.heal_5': 'Heal 5 HP',
    'menu.toggle_squeeze': 'Toggle Squeeze',
    'menu.gm_hide_token': 'GM: Hide from Players',
    'menu.gm_reveal_token': 'GM: Reveal to Players',
    'menu.gm_delete_token': 'GM: Remove Token',
    'menu.door_open': 'Open Door',
    'menu.door_close': 'Close Door',
    'menu.gm_door_lock': 'GM: Toggle Door Lock',
    'menu.gm_door_secret': 'GM: Toggle Secret Door',
  },
  fr: {
    'workspace.tab.characters': 'Personnages & Groupe',
    'workspace.tab.maps_gm': 'Studio Cartes & Préparation',
    'workspace.tab.maps_player': 'Atlas Révélé',
    'workspace.tab.documents': 'Journal & Documents',
    'workspace.tab.table': 'Table en Direct',
    'sheet.locked': 'Stats Verrouillées (Cliquer = Jet)',
    'sheet.unlocked': 'Mode Édition (Déverrouillé)',
    'sheet.gm_locked': 'Verrouillé par le MJ',
    'sheet.level_up': '⬆ Niveau Supérieur',
    'sheet.short_rest': 'Repos Court',
    'sheet.long_rest': 'Repos Long',
    'ability.str': 'FOR',
    'ability.dex': 'DEX',
    'ability.con': 'CON',
    'ability.int': 'INT',
    'ability.wis': 'SAG',
    'ability.cha': 'CHA',
    'menu.move_here': 'Déplacer le jeton ici',
    'menu.cast_aoe': 'Projeter Sphère AoE (6 m)',
    'menu.ping_here': 'Signaler ici (Ping)',
    'menu.gm_teleport': 'MJ : Téléporter ici',
    'menu.gm_spawn_monster': 'MJ : Invoquer Monstre ici',
    'menu.attack_melee': 'Attaque au corps à corps',
    'menu.damage_5': 'Infliger 5 dégâts',
    'menu.heal_5': 'Soigner 5 PV',
    'menu.toggle_squeeze': 'Se faufiler (Squeeze)',
    'menu.gm_hide_token': 'MJ : Masquer aux joueurs',
    'menu.gm_reveal_token': 'MJ : Révéler aux joueurs',
    'menu.gm_delete_token': 'MJ : Supprimer le jeton',
    'menu.door_open': 'Ouvrir la porte',
    'menu.door_close': 'Fermer la porte',
    'menu.gm_door_lock': 'MJ : Verrouiller / Déverrouiller',
    'menu.gm_door_secret': 'MJ : Basculer Porte Secrète',
  },
};

export function t(key: string): string {
  const lang = localeSignal.value;
  return DICTIONARY[lang]?.[key] ?? DICTIONARY.en[key] ?? key;
}

export function formatDistanceFt(feet: number, includeSquares = false): string {
  const squares = Math.round((feet / 5) * 10) / 10;
  if (unitSystemSignal.value === 'metric_m') {
    const meters = Math.round(feet * 0.3 * 10) / 10;
    return includeSquares ? `${meters} m (${squares} cases)` : `${meters} m`;
  }
  return includeSquares ? `${Math.round(feet)} ft (${squares} sq)` : `${Math.round(feet)} ft`;
}

export interface BilingualCompendiumEntry {
  id: string;
  category: 'weapon' | 'armor' | 'container' | 'gear' | 'spell' | 'feat' | 'monster';
  nameEn: string;
  nameFr: string;
  summaryEn: string;
  summaryFr: string;
  damageDice?: string;
  hp?: number;
  ac?: number;
}

export const BILINGUAL_SRD_COMPENDIUM: BilingualCompendiumEntry[] = [
  {
    id: 'srd:weapon:longsword',
    category: 'weapon',
    nameEn: 'Longsword',
    nameFr: 'Épée longue',
    summaryEn: '1d8 slashing (versatile 1d10)',
    summaryFr: '1d8 tranchant (polyvalente 1d10)',
    damageDice: '1d8+3',
  },
  {
    id: 'srd:weapon:shortbow',
    category: 'weapon',
    nameEn: 'Shortbow',
    nameFr: 'Arc court',
    summaryEn: '1d6 piercing (range 80/320 ft)',
    summaryFr: '1d6 perforant (portée 24/96 m)',
    damageDice: '1d6+3',
  },
  {
    id: 'srd:container:bag_of_holding',
    category: 'container',
    nameEn: 'Bag of Holding',
    nameFr: 'Sac sans fond',
    summaryEn: 'Extradimensional container (0x carried weight, 500 lb capacity)',
    summaryFr: 'Conteneur extradimensionnel (poids porté x0, capacité 250 kg)',
  },
  {
    id: 'srd:spell:fireball',
    category: 'spell',
    nameEn: 'Fireball',
    nameFr: 'Boule de feu',
    summaryEn: 'Level 3 Evocation • 20 ft Sphere • 8d6 fire (DEX save)',
    summaryFr: 'Évocation Niv 3 • Sphère 6 m • 8d6 feu (JS DEX)',
    damageDice: '8d6',
  },
  {
    id: 'srd:spell:cure_wounds',
    category: 'spell',
    nameEn: 'Cure Wounds',
    nameFr: 'Soin des blessures',
    summaryEn: 'Level 1 Evocation • Touch • 1d8 + spellcasting mod healing',
    summaryFr: 'Évocation Niv 1 • Contact • Soigne 1d8 + mod incantation',
    damageDice: '1d8+3',
  },
  {
    id: 'srd:feat:alert',
    category: 'feat',
    nameEn: 'Alert',
    nameFr: 'Vigilant',
    summaryEn: '+5 bonus to Initiative, cannot be surprised while conscious',
    summaryFr: '+5 en Initiative, ne peut être surpris tant que conscient',
  },
  {
    id: 'srd:monster:goblin_skirmisher',
    category: 'monster',
    nameEn: 'Goblin Skirmisher',
    nameFr: 'Gobelin éclaireur',
    summaryEn: 'Small humanoid • AC 15 • HP 12 • Scimitar 1d6+2',
    summaryFr: 'Humanoïde (P) • CA 15 • PV 12 • Cimeterre 1d6+2',
    hp: 12,
    ac: 15,
  },
  {
    id: 'srd:monster:skeleton_guard',
    category: 'monster',
    nameEn: 'Skeleton Guard',
    nameFr: 'Squelette garde',
    summaryEn: 'Medium undead • AC 13 • HP 16 • Shortsword 1d6+2',
    summaryFr: 'Mort-vivant (M) • CA 13 • PV 16 • Épée courte 1d6+2',
    hp: 16,
    ac: 13,
  },
  {
    id: 'srd:monster:ogre_brute',
    category: 'monster',
    nameEn: 'Ogre Brute',
    nameFr: 'Ogre brutal',
    summaryEn: 'Large giant • AC 11 • HP 59 • Greatclub 2d8+4',
    summaryFr: 'Géant (G) • CA 11 • PV 59 • Massue 2d8+4',
    hp: 59,
    ac: 11,
  },
];

export function searchBilingualCompendium(
  query: string,
  category?: BilingualCompendiumEntry['category'],
): BilingualCompendiumEntry[] {
  const q = query.trim().toLowerCase();
  return BILINGUAL_SRD_COMPENDIUM.filter((entry) => {
    if (category && entry.category !== category) return false;
    if (!q) return true;
    return (
      entry.nameEn.toLowerCase().includes(q) ||
      entry.nameFr.toLowerCase().includes(q) ||
      entry.id.toLowerCase().includes(q) ||
      entry.summaryEn.toLowerCase().includes(q) ||
      entry.summaryFr.toLowerCase().includes(q)
    );
  });
}
