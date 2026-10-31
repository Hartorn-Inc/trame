/**
 * ============================================================================
 * CAMPAIGN WORKSPACE, PADLOCK SHEET, BILINGUAL I18N & RIGHT-CLICK UX TESTS
 * ============================================================================
 *
 * Validates:
 *   1. 4-Tab CampaignWorkspace state transitions (`characters`, `maps`, `documents`, `table`).
 *   2. Padlock-protected Character Sheet (`coreStatsLockedSignal`) and CombatAutomationMode.
 *   3. 4-Layer Bilingual (FR/EN) & Metric/Imperial (`5 ft = 1.5 m = 1 sq/case`) unit formatting.
 *   4. Bilingual SRD 5.1 Compendium dual-index search (`Fireball` / `Boule de feu`).
 *   5. Canonical `SPAWN_TOKEN` payload builder & `HandoutRevealed` reactive modal signal.
 * ============================================================================
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatDistanceFt,
  localeSignal,
  searchBilingualCompendium,
  t,
  unitSystemSignal,
} from '../src/i18n/index.ts';
import { buildDefaultSpawnTokenPayload } from '../src/net/wsClient.ts';
import {
  activeHandoutModalSignal,
  activeWorkspaceTabSignal,
  combatAutomationModeSignal,
  coreStatsLockedSignal,
} from '../src/store/signals.ts';

describe('CampaignWorkspace, Padlock Sheet, Bilingual i18n & Right-Click VTT Suite', () => {
  it('switches workspace tabs cleanly and defaults coreStatsLockedSignal to true (locked)', () => {
    assert.equal(coreStatsLockedSignal.value, true, 'Sheet core stats must be locked by default');
    assert.equal(activeWorkspaceTabSignal.value, 'table');

    activeWorkspaceTabSignal.value = 'characters';
    assert.equal(activeWorkspaceTabSignal.value, 'characters');

    coreStatsLockedSignal.value = false;
    assert.equal(coreStatsLockedSignal.value, false);
    coreStatsLockedSignal.value = true;
  });

  it('formats tactical distances in both Imperial (ft/sq) and Metric (m/cases) without changing internal feet math', () => {
    const cases: Array<{
      id: string;
      feet: number;
      expectedImperial: string;
      expectedMetric: string;
    }> = [
      {
        id: 'standard-30ft-movement',
        feet: 30,
        expectedImperial: '30 ft (6 sq)',
        expectedMetric: '9 m (6 cases)',
      },
      {
        id: 'fireball-20ft-radius',
        feet: 20,
        expectedImperial: '20 ft (4 sq)',
        expectedMetric: '6 m (4 cases)',
      },
      {
        id: 'melee-reach-5ft',
        feet: 5,
        expectedImperial: '5 ft (1 sq)',
        expectedMetric: '1.5 m (1 cases)',
      },
    ];

    for (const tc of cases) {
      unitSystemSignal.value = 'imperial_ft';
      assert.equal(formatDistanceFt(tc.feet, true), tc.expectedImperial, tc.id);

      unitSystemSignal.value = 'metric_m';
      assert.equal(formatDistanceFt(tc.feet, true), tc.expectedMetric, tc.id);
    }
    unitSystemSignal.value = 'imperial_ft';
  });

  it('translates workspace tabs and right-click context menu labels between English and French', () => {
    localeSignal.value = 'en';
    assert.equal(t('workspace.tab.characters'), 'Characters & Party');
    assert.equal(t('menu.gm_hide_token'), 'GM: Hide from Players');

    localeSignal.value = 'fr';
    assert.equal(t('workspace.tab.characters'), 'Personnages & Groupe');
    assert.equal(t('menu.gm_hide_token'), 'MJ : Masquer aux joueurs');
    localeSignal.value = 'en';
  });

  it('searches bilingual SRD 5.1 compendium by either English (VO) or French (VF) query', () => {
    const byFrench = searchBilingualCompendium('Boule de feu');
    assert.equal(byFrench.length, 1);
    assert.equal(byFrench[0].id, 'srd:spell:fireball');

    const byEnglish = searchBilingualCompendium('Bag of Holding');
    assert.equal(byEnglish.length, 1);
    assert.equal(byEnglish[0].id, 'srd:container:bag_of_holding');

    const monsters = searchBilingualCompendium('', 'monster');
    assert.ok(monsters.length >= 3, 'Should return built-in SRD monsters for GM quick-spawn');
  });

  it('builds canonical SPAWN_TOKEN payloads and manages CombatAutomationMode & HandoutRevealed modal state', () => {
    const tok = buildDefaultSpawnTokenPayload({
      id: '00000000-0000-0000-0000-000000000123',
      name: 'Goblin Skirmisher',
      owner_user_id: null,
      top_left: { x: 128, y: 192 },
      hp: 12,
      max_hp: 12,
      visibility_channel: 5,
    });
    assert.equal(tok.name, 'Goblin Skirmisher');
    assert.equal(tok.hp, 12);
    assert.equal(tok.visibility_channel, 5);
    assert.equal(tok.senses.darkvision_range_ft, 60);

    combatAutomationModeSignal.value = 'FULL_AUTOMATION';
    assert.equal(combatAutomationModeSignal.value, 'FULL_AUTOMATION');
    combatAutomationModeSignal.value = 'ASSISTED_DM_CONFIRM';

    activeHandoutModalSignal.value = {
      handout_id: 'h-test',
      campaign_id: 'c-test',
      title: 'Ancient Letter',
      content: 'Meet at the Old Owl Well.',
      revealed_at: 1700000000,
      revealed_by: 'GM',
    };
    assert.equal(activeHandoutModalSignal.value?.title, 'Ancient Letter');
    activeHandoutModalSignal.value = null;
  });
});
