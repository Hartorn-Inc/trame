/**
 * ============================================================================
 * MONSTER TURN PANEL (table/MonsterTurnPanel.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lets the GM run a monster's turn through decision D6: when the selected
 * token carries a stat block (`stat_block`, the server's copy for spawned
 * SRD monsters), its `MonsterStatBlockView` is shown with a button per
 * attack or save action. The button opens the resolution card as a
 * `monster` pending action, which the room rolls against the targets' real
 * AC and save bonuses like any other action. A save action with an area
 * (breath weapon) is placed on the board like an area spell, from the
 * monster's token, and its targets come from the engine's projection.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `GM Only`:
 *    - Players never receive `stat_block` (it is GM-only in the projection);
 *      the panel also renders nothing for them.
 * 2. `No Sheet Needed`:
 *    - The pending action references the token and the action id; the card
 *      reads the stat block from the table, so a monster without an actor
 *      sheet is fully playable.
 * ============================================================================
 */
import { selectedTokenIdSignal } from '../api/session.ts';
import type { ApiClient } from '../api/client.ts';
import { isMonsterStatBlock, MonsterStatBlockView } from '../compendium/MonsterStatBlockView.tsx';
import { monsterPendingAction, startAction } from './actionResolution.ts';

export interface MonsterTurnPanelProps {
  client: ApiClient;
  isGm: boolean;
}

export function MonsterTurnPanel({ client, isGm }: MonsterTurnPanelProps) {
  const tokenId = selectedTokenIdSignal.value;
  if (!isGm || !tokenId) return null;
  const block = client.state.table.value?.tokens[tokenId]?.stat_block;
  if (!isMonsterStatBlock(block)) return null;
  return (
    <MonsterStatBlockView
      statBlock={block}
      testId="monster-turn"
      onAction={(action) => startAction(monsterPendingAction(tokenId, action))}
    />
  );
}
