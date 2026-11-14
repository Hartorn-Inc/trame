# ADR-0042: Server-Held Pending Resolutions for Attacks, Area Saves and Concentration

## Status
Accepted (2026-11-06). Implements decision D6 and stories 50-54 and 58 of [`spec-internet-ready-playable-trame.md`](../specs/spec-internet-ready-playable-trame.md) without weakening story 47 (`PublicTokenView`, `BloodiedState`). Builds on the WAL model of [ADR-0040](./0040-wal-recovery-with-quarantine.md).

## Context
D6 resolves an attack as to-hit against the target's Armor Class, a damage roll, then an explicit Apply by the attacker or the Game Master; an area spell shows each affected token with save / save-for-half controls. The first implementation rolled everything in the browser. That works when the roller can see the target's numbers, but a player never sees a monster's AC or save bonuses. The card then asked the player to rule hit / miss and each monster's save, Apply was disabled for tokens the player does not control, and the Game Master only received raw dice-log lines. The most common combat action, a player attacking a monster, dead-ended. A partial failure while applying several targets could also apply damage twice.

## Considered Options
1. **Reveal AC and save bonuses to the attacker.** Rejected: breaks story 47 and the G5 privacy model.
2. **Send the player's roll to the Game Master for a ruling.** Rejected: every attack blocks on the Game Master and the player's d20 total still bounds the AC.
3. **Ephemeral server-side resolution with a timeout.** Rejected: a restart or hibernation silently loses rolled damage, and undo cannot restore it with the hit points it relates to.
4. **Server rolls against server-side numbers and stores a WAL-recorded `PendingResolution` (Recommended).**

## Decision
1. **Server-rolled commands.** `ResolveAction { request }` carries what the issuer knows: attack bonus and critical range (own sheet or, for the Game Master, the stat block), or save ability and DC, damage dice, flat modifier and type, and per target the accepted cover and the advantage state of the attack. The room rolls every d20 and damage die, compares with the target's AC and its server-side save bonus (`TokenState::save_bonuses` synced from a linked sheet, else the `stat_block` copy), applies automatic critical hits (Paralyzed / Unconscious within 5 ft, by 3D distance, never without an attacker token), automatic save failures and the Restrained Dexterity disadvantage, doubles only the damage dice on a critical hit, and halves on a successful save when the spell says so. It fills `ResolveAction.resolution` before the engine runs, like `ActivateScene`.
2. **Trust boundary.** The attack bonus and the attack's advantage state come from the client: they derive from the attacker's own sheet, whose ability scores are bounded server-side, and every request field is bounded. Save advantage from the client is honored only for the Game Master or the target's controller. A player may only target tokens in their projection. The rolls never go to the dice log.
3. **Pending resolution in the snapshot.** The engine stores the result in `TableSnapshotData::pending_resolutions` (at most 32, oldest dropped). The WAL records the filled command, so replay reproduces the same rolls; undo restores the resolution with the hit points. `ActivateScene` clears it.
4. **Apply exactly once.** `ApplyResolution { resolution_id, token_id?, adjustment? }` applies the stored typed damage (the engine derives each target's affinity) and marks targets applied; an applied target is never damaged again. The issuer applies as rolled; only the Game Master adjusts amount, type or critical, or dismisses (`DismissResolution`).
5. **Privacy.** A pending resolution reaches the Game Master and its issuer only. For the issuer, targets they do not control keep outcome and damage but lose their natural d20s and total.
6. **Concentration checks.** Damage to a concentrating token that keeps hit points queues the DC in `pending_concentration_checks` (`ConcentrationCheckRequested`, controller and Game Master only). `RollConcentrationCheck` is rolled by the room with the token's server-side Constitution save bonus; a failure ends concentration and its persistent zone.

## Consequences
### Positive
- A player can attack or blast a monster end to end; the Game Master sees every pending result and can apply or adjust it.
- No AC, hit point number, save bonus or raw save roll of a hidden target reaches a player.
- Restarts, hibernation and undo keep pending results consistent with hit points.

### Negative
- Attack bonus and attack advantage remain client-asserted; a modified client can inflate them within the bounds.
- Save bonuses of linked sheets ignore feats and magic items not modelled on the server.
- Pending results grow the snapshot (bounded to 32 entries of at most 32 targets).
