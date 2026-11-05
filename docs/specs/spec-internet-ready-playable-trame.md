# Specification: Internet-ready Playable TRAME (v4)

- **Identifier**: `spec-internet-ready-playable-trame`
- **Version**: v4
- **Status**: Approved
- **Date**: 2026-11-05
- **Relation**: builds on [`spec-playable-dnd5e-campaign-convergence.md`](./spec-playable-dnd5e-campaign-convergence.md) (v3, delivered in PR #151) and does not replace it. Everything v3 shipped stays in force unless a decision below changes it.
- **Related ADRs**: `ADR-0010` (amended by `ADR-0039` and `ADR-0041`), `ADR-0037`, `ADR-0038`, `ADR-0039`, `ADR-0040`, `ADR-0041`
- **Glossary**: every domain term below is defined in `GLOSSARY.md`.

---

## Problem Statement

A Game Master wants to run a real D&D 5e campaign with friends who join over the internet. TRAME passes its 34-phase browser journey, but the four audits of 2026-11-05 show that a real session would break, and that exposing the server publicly is unsafe.

**The table is not fully playable.**
- Doors can be drawn but not opened during play.
- Compendium monsters land on the table as 20 HP / AC 10 tokens with no stat block. Tokens can't be removed or revealed from the table.
- Character sheets show no attacks, spells or features. Level-1 casters have no spell slots.
- There is no UI for AoE targeting from a spell, conditions, concentration or death saves. Damage type and critical hits can't be chosen.
- The fog brush and wall drawing in the map studio are placeholders. The canvas has no zoom or pan.
- Content is thin (61 spells, 40 monsters). Class features, conditions and several rules are not automated or are wrong: long rest recovers half the Hit Dice, critical hits double modifiers, movement is Euclidean, and the concentration DC is uncapped.

**A session can be lost.**
- Undo followed by a server crash leaves the campaign unloadable (verified).
- A failed WAL append leaves memory ahead of disk. A snapshot failure aborts the command.
- A dead room actor is never cleaned up, so the campaign stays unreachable until restart.
- The client never reconnects after a network drop and gives no feedback when a command fails.
- Map images break after every restart because the instance id is random (verified). Without `DATABASE_URL` the server silently runs in memory.

**Exposing it is unsafe.**
- A player can export the campaign, including GM secrets (verified).
- Archive import accepts zip bombs.
- Anyone can register. Players can pick their own initiative, and initiative rolls leak hidden monsters.
- The rate limiter can be bypassed. Public constructors fall back to hardcoded keys.
- Several realtime events leak HP, hidden tokens or reaction prompts to the wrong players.
- There is no TLS edge, no backup, and no tested restore.

**Hosting isn't free or documented.** The Cloud Run template expects Cloud SQL, which is not free. There is no strictly-free path, and no guidance on egress, compression or cost.

## Solution

After the four stacked wave PRs land on `dev`, an `Owner` deploys TRAME for free (Compose + Caddy on an Oracle Always Free VM or a home machine behind Cloudflare Tunnel) or for a few cents a month (Cloud Run Paris + Neon + R2). The `Owner` claims the instance with a one-time setup link and promotes trusted friends to `Host`. A `Host` creates a campaign and shares one bounded `CampaignInvite`. Players redeem it into a real account in under a minute, and nobody else can register.

At the table, players build complete level-1 characters from the full SRD 5.2.1 content. They explore with doors, fog and darkvision, and fight monsters with real stat blocks. Combat is semi-automated:
- TRAME rolls to hit against the target's AC and rolls damage.
- The attacker or GM confirms with an explicit Apply.
- AoE spells list the affected tokens with save and save-half controls.
- Class features and conditions adjust the numbers automatically. The GM can override any of them.

The server survives crashes, undo and restarts without locking a campaign. Clients reconnect on their own. Backups run nightly and the restore path is tested. All traffic is compressed when the client allows it.

## User Stories

**Instance administration**
1. As an `Owner` deploying a fresh instance, I want the first boot to log a one-time setup URL valid for one hour, so that only I can claim the instance.
2. As an `Owner`, I want to lock the setup to one email with `TRAME_BOOTSTRAP_OWNER_EMAIL`, so that an intercepted setup link is useless to anyone else.
3. As an `Owner`, I want public registration closed outside `TRAME_ENV=dev`, so that strangers can't create accounts on my server.
4. As an `Owner`, I want to promote a `Member` to `Host` and demote them later, so that I decide who can create campaigns.
5. As an `Owner`, I want to see every account and its `InstanceRole`, so that I know who has access.
6. As an `Owner`, I want to be strongly nudged to enable TOTP, so that the most powerful account is the best protected.
7. As an operator, I want the instance id persisted in Postgres (with an optional `TRAME_INSTANCE_ID` override), so that map images and signed URLs survive restarts.
8. As an operator, I want the server to refuse to start without `DATABASE_URL` outside dev, so that a misconfiguration never silently loses data.
9. As an operator, I want known dev secret values rejected outside dev and no hardcoded fallback keys anywhere, so that a production instance never runs on public keys.

**Campaign access and invites**
10. As a `Host`, I want to create a campaign and become its `GameMaster`, so that I can prepare it.
11. As a `Member`, I want the create-campaign action hidden and refused by the server, so that the instance stays curated.
12. As a `GameMaster`, I want one `CampaignInvite` link per campaign with a max-uses count (default 8) and a TTL of up to 7 days, so that a leaked link has limited reach.
13. As a `GameMaster`, I want to revoke the invite and mint a new one, so that I can cut off a leaked link.
14. As a `GameMaster`, I want to see who redeemed the invite and when, so that I can spot strangers.
15. As an invited visitor without an account, I want `InviteRedemption` to create my `Member` account (display name, email, password) and join the campaign as a `Player`, so that I'm at the table in under a minute with a real, recoverable account.
16. As an invited user who is already logged in, I want the invite to attach the campaign to my existing account, so that I don't end up with duplicates.
17. As a user still holding a legacy guest session, I want a bind prompt that turns it into a real account, so that I keep my characters.
18. As a `GameMaster`, I want removing a member to disconnect their live sockets immediately, so that a removed player can't keep watching.
19. As any user, I want TOTP to be optional but recommended in my account settings, so that I can choose my security level.
20. As a user, I want failed logins, TOTP codes and bind attempts throttled per account and per network (IPv6 grouped by /64), and only failures counted, so that brute force is impractical and normal use is never blocked.

**Recovery and connectivity**
21. As a `GameMaster`, I want undo to be safe across a server crash, so that the campaign always reloads.
22. As a `GameMaster`, I want a WAL entry that fails to replay set aside as a `QuarantinedWalEntry` while the room opens at the last good state, so that one bad entry never locks the campaign.
23. As a `GameMaster`, I want a banner telling me that entries were quarantined and roughly what they were, so that I can redo the lost actions by hand.
24. As a `GameMaster`, I want MCP staging proposals to survive a restart, so that pending assistant work isn't silently lost.
25. As a player, I want my command rejected cleanly if the server can't persist it, so that what I see always matches what was saved.
26. As a player, I want every failed command to show a clear message tied to the action I took, so that I know what to retry.
27. As a player, I want the client to reconnect automatically with backoff after a network drop, server restart or deploy, and resync the full state, so that I don't have to reload.
28. As a player, I want a status banner (connected, reconnecting, offline), so that I know whether my actions reach the table.
29. As a `GameMaster`, I want a crashed room to be restarted on the next connection, so that the campaign never stays stuck until a server restart.
30. As a `GameMaster`, I want to know that the undo history is kept in memory and is lost on restart, so that I'm not surprised.

**Exploration**
31. As a player, I want to open and close unlocked doors from the table, so that I can explore without asking the GM.
32. As a `GameMaster`, I want to lock, unlock, open and close any door, and keep secret doors invisible to players until revealed, so that the map stays mine.
33. As a player, I want movement measured on the grid with 5-ft diagonals (Chebyshev), so that distances follow SRD 5.2.1.
34. As a `GameMaster`, I want to paint difficult terrain in the map studio, so that movement through it costs double.
35. As a `GameMaster`, I want to draw walls and doors directly on the map canvas, so that I don't need an external tool for small maps.
36. As a `GameMaster`, I want a real fog brush to reveal and hide areas, so that I control what players discover.
37. As a player, I want explored areas remembered as a desaturated map without live enemies (fog memory), so that I can find my way back.
38. As a player with darkvision, I want my token to see in darkness in greyscale within its range, while my friend without darkvision does not, so that senses matter.
39. As a player, I want to zoom and pan the map with mouse, trackpad and touch, so that I can follow the action on large maps.
40. As a player, I want one-way and terrain walls to behave exactly as drawn, so that the map works as designed.

**Monsters and tokens**
41. As a `GameMaster`, I want to spawn a monster from the compendium straight onto the table, so that I can improvise encounters.
42. As a `GameMaster`, I want staged and spawned monsters to carry their full stat block (HP, AC, speed, senses, actions, multiattack, traits, legendary actions, affinities), copied when staged and editable as homebrew, so that each goblin is a real goblin.
43. As a `GameMaster`, I want the server to validate stat-block bounds, so that a broken homebrew entry can't corrupt the table.
44. As a `GameMaster`, I want a token menu to remove, reveal, hide or teleport a token and override its remaining speed, so that I can fix the table quickly.
45. As a player, I want my linked token's AC and speed to follow my sheet, so that the table uses my real numbers.
46. As a player, I want hidden monsters to stay hidden everywhere (initiative, removal events, reaction prompts, timeline), so that surprises are preserved.
47. As a player, I want enemy HP never revealed through damage, healing or AoE events, only through `BloodiedState`, so that numbers stay secret.

**Combat resolution**
48. As a player, I want the server to roll my initiative as `1d20` plus my derived initiative bonus (including Alert), ignoring any value I send, so that initiative is fair.
49. As a `GameMaster`, I want initiative for monsters players can't see to be visible only to me, and broadcast only after the command commits, so that nothing leaks or desyncs.
50. As a player attacking, I want TRAME to roll to hit with the action's own attack bonus against the target's AC and show hit or miss, so that I don't do arithmetic.
51. As a player who hits, I want damage rolled with the right dice and type, with critical hits doubling only the dice, so that damage follows SRD 5.2.1.
52. As the attacker or the `GameMaster`, I want an explicit Apply step (with damage type and critical shown), so that a misclick never changes HP.
53. As a player casting an AoE spell from my spellbook, I want to place the template and see the list of affected tokens, so that targeting is visual.
54. As the caster or `GameMaster`, I want save, save-half and fail controls per affected token, using the spell's own save DC, so that AoE resolution is quick and correct.
55. As a `GameMaster`, I want TRAME to suggest cover (half, three-quarters, total) from the walls between attacker and target, and to confirm it myself, so that cover is fast but under my control.
56. As a player, I want my weapon's reach to define my threat range, so that reach weapons trigger opportunity attacks correctly.
57. As a player, I want to take the Disengage action so that my movement triggers no opportunity attacks this turn.
58. As a player concentrating on a spell, I want a concentration toggle and an automatic check prompt with DC `max(10, floor(damage/2))` capped at 30 when I take damage, so that concentration follows the rules.
59. As a player at 0 HP, I want death saves rolled, tracked and synced to the table (three successes stabilize, three failures kill, a natural 20 restores 1 HP), so that dying is dramatic and correct.
60. As a player, I want to apply a condition to my own token, and the `GameMaster` to any token, with undo, so that conditions are tracked on the table.
61. As a player, I want conditions to apply their roll effects automatically (advantage, disadvantage, auto-fail, speed 0), with advantage and disadvantage cancelling per SRD, so that I don't have to remember them.
62. As a `GameMaster`, I want a `ConditionOverride` to force or remove any condition or effect on any linked or synthetic token, so that I can rule on edge cases.

**Characters, classes and content**
63. As a player, I want my sheet to list my attacks (weapons and attack spells with bonus and damage), my spells (prepared and known, slots per level) and my features, so that I can play from the sheet.
64. As a level-1 caster, I want my spell slots, Pact Magic, cantrips and known or prepared spells from the start, so that I can cast in the first session.
65. As a player in the builder, I want steps for class skills, starting equipment and spells, so that a new character is complete.
66. As a player, I want my armor, shield and proficiencies to feed my AC and attack bonuses, so that equipping gear matters.
67. As a player, I want a long rest to restore all my Hit Dice, so that rests follow SRD 5.2.1.
68. As a player with a Fighting Style, Magic Initiate or Skilled, I want to make the choices those feats require, so that my build is legal.
69. As a player, I want class features from level 1 to 20 for all 12 classes and their 12 SRD subclasses, with their uses tracked as `ResourcePool`s that refill on the right rest, so that I never track charges on paper.
70. As a player, I want features that change a number or a roll rule (Rage, Extra Attack, Unarmored Defense, Sneak Attack, Divine Smite, advantage grants) applied automatically as `ActiveEffect`s, so that my sheet is always right.
71. As a player using Wild Shape, a summon or Polymorph, I want a use counter and a manual workflow, so that I can still play these features until they are automated.
72. As a `GameMaster` or player, I want the full SRD 5.2.1 content (about 339 spells, about 330 monsters, core magic items with attunement), so that a campaign never runs out of material.
73. As a `GameMaster`, I want the CC-BY-4.0 attribution shown in the app, so that the instance complies with the SRD license.
74. As a player, I want dice expressions like `4d6kh0` or `2d20kh5` rejected with a clear error, so that broken rolls don't silently produce nonsense.

**Data protection**
75. As a `GameMaster`, I want only campaign GMs to be able to export a campaign, so that players can't download my secrets.
76. As an operator, I want archive imports streamed and rejected on duplicate entry names, oversized entries or a total decompressed size over the cap, and limited per account, so that one upload can't take the server down.
77. As an operator, I want image decoding, encoding and password hashing run off the async runtime, with pixel-area and per-campaign storage quotas, so that one heavy upload doesn't freeze every table.
78. As an operator, I want clients never to receive raw database errors, so that the schema stays private.
79. As an operator, I want `/healthz` to check Postgres, so that the platform restarts a broken instance.
80. As an operator, I want a nightly `pg_dump` kept 14 days and copied to R2, plus a restore script, so that a dead disk or a bad deploy costs at most a day.

**Hosting and traffic**
81. As an `Owner` with no budget, I want a documented Compose + Caddy deployment with automatic HTTPS on an Oracle Always Free VM or a home machine behind Cloudflare Tunnel, so that hosting costs 0 EUR.
82. As an `Owner` accepting a card on file, I want a documented Terraform deployment on Cloud Run `europe-west9` + Neon + R2 with a 1 EUR budget alert, so that hosting costs a few cents with no server to maintain.
83. As an `Owner`, I want the free-tier limits, risks (Oracle idle reclamation, capacity) and egress costs documented, so that I choose with full information.
84. As a player on a slow connection, I want every HTTP response compressed according to my `Accept-Encoding` (images and fonts excepted), so that the app loads fast and egress stays cheap.
85. As a player, I want WebSocket traffic compressed and unchanged state frames skipped, so that long sessions use little bandwidth.
86. As a player, I want map images and portraits downloaded directly from object storage through signed URLs when S3 is configured, so that loading is fast and the server stays light.
87. As an operator, I want only the edge proxy to publish ports, with the trusted-proxy hop count configured, so that client IPs are real and internal services are unreachable.
88. As an operator, I want memory limits sized for each service, so that a leak can't take the whole VM down.

**Contributors**
89. As a contributor, I want `make e2e` to run in CI on PRs to `dev`, so that regressions in the full journey are caught before merge.
90. As a contributor, I want the new terms in `GLOSSARY.md`, the new ADRs written before the code, and deferred items tracked as GitHub issues, so that the docs and the backlog match the code.

## Implementation Decisions

Decision numbers refer to the decision log below.

**Identity and access (D1, D2, D3, D15, D16)**
- `InstanceRole` (`Owner`, `Host`, `Member`) is stored on the user account, independent of the per-campaign `UserRole`. Exactly one `Owner` is allowed. New accounts are `Member`. Creating a campaign requires `Host` or `Owner`. Only the `Owner` changes `InstanceRole`s.
- Owner bootstrap: on boot with no `Owner`, the server mints a single-use token valid one hour and logs the full setup URL once. The token is stored hashed and invalidated after use or expiry. Redeeming it creates the `Owner` account, or claims the locked email when `TRAME_BOOTSTRAP_OWNER_EMAIL` is set. A restart with no `Owner` mints a fresh token.
- Public registration is closed outside `TRAME_ENV=dev`. Accounts come only from owner bootstrap or `InviteRedemption`.
- `CampaignInvite` record: campaign, token hash, creator, `expires_at` (at most 7 days), `max_uses` (default 8), `use_count`, `revoked_at`. Redemptions are stored as their own records (invite, user, timestamp). Minting a new invite revokes the previous one, so there is one active link per campaign. The URL is built from `TRAME_PUBLIC_ORIGIN`.
- API contract: GM-only create, read-active, revoke and list-redemptions routes under the campaign. An unauthenticated redeem route creates a `Member` account and a `Player` membership in one transaction. An authenticated redeem route only adds a membership. An Owner-only instance admin API lists users and sets `InstanceRole`.
- `GuestSessionUpgrade` is removed. Legacy guest sessions keep the existing bind flow and see a bind prompt.
- Every role check goes through `resolve_campaign_role`. The room re-checks membership on change and closes the sockets of removed members.
- TOTP stays optional. The UI shows a recommendation on account settings, stronger for the `Owner`.

**Configuration**
- The instance id is stored in a single-row instance settings table and created on first boot. `TRAME_INSTANCE_ID` overrides it. A mismatch between the two logs a warning.
- `DATABASE_URL` is required outside dev. The in-memory store remains only for dev and tests.
- Public constructors take keys explicitly, with no fallbacks. Startup rejects the known dev secret values outside dev.
- New settings: `TRAME_BOOTSTRAP_OWNER_EMAIL`, `TRAME_TRUSTED_PROXY_HOPS`, and the S3 settings (`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, credentials). All are documented in the README config table.

**WAL recovery and room lifecycle (D4)**
- After `UndoLastAction`, the room writes a snapshot, as batches already do. MCP staging proposals are written to the WAL so they replay.
- Replay applies entries in order on top of the latest snapshot. An entry that fails is moved, with all later entries, to a `QuarantinedWalEntry` table (campaign, sequence, payload, error, timestamp). The room opens at the last good state, writes a fresh snapshot, and emits a GM-only event that the frontend shows as a banner. Quarantined entries are kept for inspection and are never replayed automatically.
- Command execution clones the state and sequence before applying. If the WAL append fails, the room restores the clone and rejects the command. A snapshot failure is logged and the command still commits and broadcasts.
- `CommandRejected` carries the client's correlation id for every error path.
- When a room actor task ends, its handle is removed from the registry, so the next connection starts a fresh actor.
- The undo ring stays in memory only. Its loss on restart is documented in the ADR.

**Security hardening**
- Archive import streams the request body with no full in-memory copy. It rejects duplicate entry names, enforces per-entry and running-total decompressed byte caps, and applies a per-account import quota. Legacy `assets/*.webp` entries go to the persistent asset store.
- Export requires the `GameMaster` role. Players and spectators get `403`.
- Initiative is rolled by the server only, as `1d20` plus the derived initiative bonus. A player-supplied value is ignored, and only the first roll per encounter counts.
- The rate limiter keys by route and account and counts only failures. TOTP gets an exponential backoff. The client IP is resolved through the configured trusted-proxy hop count, and IPv6 is bucketed by /64. The bind routes are covered.
- CPU-heavy work (image decode and encode, argon2) runs on the blocking pool. Pixel-area caps and per-campaign storage quotas are enforced before decoding.
- Database errors are mapped to generic client errors. `/healthz` pings Postgres. The timeline route uses an explicit allow-list of event kinds per role.
- Dice: `kh`/`kl` requires `1 <= k <= count`. Anything else is a parse error.

**Realtime privacy (S-D)**
- One audience rule for reaction prompts in both state and events: the reactor's controller and the GM. The trigger's controller is not included, and hidden reactors are redacted.
- `TokenRemoved` and controller-only events are filtered by visibility. `speed_remaining_ft` is zeroed for non-controllers, and `ActionRefunded` goes only to the controller.
- `TokenHealed` and `DamageApplied` carry HP only for GM and controller recipients. Everyone else gets the `BloodiedState` change. `AoeCleared` hides the caster from players who can't see them.
- Initiative rolls for tokens a player can't see are GM-only, in both events and the timeline, and fan out after the command commits.
- `PointerPing` validates its color and is throttled per client. Outbound channels are bounded: a slow consumer is disconnected and recovers through reconnect and resync. The server sends pings.

**Engine (E-A, part of C-D)**
- Grid movement cost is Chebyshev (every square is 5 ft, including diagonals). Difficult terrain is a set of grid cells stored with the map, and entering one costs double. The movement preview and server validation share the same WASM function.
- Threat reach comes from the equipped weapon (5 ft, or 10 ft with reach). A per-turn Disengage flag suppresses `ReactionPrompt`s.
- Cover is computed from the walls between attacker and target as a suggestion (`None`, `Half`, `ThreeQuarters`, `Total`). The GM confirms it, and the result feeds AC or the saving throw bonus.
- The concentration DC is `max(10, floor(damage / 2))`, capped at 30, in both engine and TypeScript.
- New `TrameCommand`s: `SetTokenConditions` (controller on own token, GM on any token) and `ConditionOverride` (GM only; forces or removes a condition or effect on linked or synthetic tokens). Both push an `UndoEntry`. On a `LinkedActorToken`, conditions sync with the `Actor`.
- The WASM vision API takes `WallKind` as input. Darkvision range is per token from its `SenseProfile`, not global.

**Game system (C-A to C-D)**
- Rule fixes:
  - Long rest restores all Hit Dice.
  - A critical hit doubles only the dice.
  - An action's own attack bonus and DC override the generic ones.
  - Concentration DC cap.
  - Mass Suggestion moves to the Warlock list.
  - Concentration flags are corrected on spells.
  - Fighting Style feats are offered at feat slots.
  - Magic Initiate and Skilled expose their choices.
- `computeDnd5eSheetDerived` keeps its signature and adds `attacks`, `spells` (slots, prepared or known, save DC and attack bonus) and `features`. Level 1 grants slots, Pact Magic, cantrips and spells. Class skills, starting equipment and proficiencies are chosen in the builder, and armor feeds AC.
- Monster schema: speed by mode, size, senses, traits, actions with multiattack, typed damage lists with riders (extra damage, condition, save), legendary actions, and damage and condition affinities. A staged token copies the stat block, bounds-validated by the server, and stays a `SyntheticToken`.
- Content is produced by a committed, reproducible generator script that reads a pinned Open5e SRD 5.2 snapshot and writes the compendium packs. The output is committed. A CC-BY-4.0 attribution page ships in the app. The game-systems reviewer checks a sample.
- `ClassFeature` = an optional `ResourcePool` (max, recovery on short or long rest) plus zero or more `ActiveEffect`s, unlocked by level for 12 classes and 12 subclasses. A feature is automated when it changes a number or a roll rule. Profile replacements stay manual with a counter (D12).
- Conditions map to `ActiveEffect`s and roll flags. Advantage and disadvantage cancel per SRD. Auto-fail and speed 0 are enforced. `ConditionOverride` always wins.
- The damage pipeline is fixed and wired into a semi-automated resolution flow: attack roll against target AC, a hit or miss result, damage roll, then an explicit Apply. Apply sends the existing damage `TrameCommand` with type and critical flag. For AoE, the template targets come from the engine, and save, save-half and fail are set per token before Apply.

**Server sync (S-D)**
- `LinkedActorToken` sync reads AC from the derived AC and speed from the speed attribute.
- Spawning from the compendium uses the same stat-block copy path as staging.

**Frontend (F-A to F-D, F-C1)**
- Account screens: owner setup, Host management, invite management (TTL, max uses, revoke, redemption list), `InviteRedemption`, the guest bind prompt, and the TOTP recommendation.
- Connection manager: reconnect with exponential backoff and jitter (including close 1001), heartbeat `Ping`, full state resync on reconnect, a connection status banner, and a toast for every `CommandRejected`, matched by correlation id.
- Table controls:
  - door handles;
  - token context menu;
  - damage type and critical controls;
  - condition picker and override;
  - concentration toggle;
  - death-save flow;
  - real fog brush;
  - wall and door drawing on the canvas;
  - terrain painting;
  - zoom and pan with touch support.
- Resolution UI: attack and spell cards with hit or miss and an Apply step, and AoE placement from the spellbook with a target list and save controls.
- Sheets render attacks, spells, features and `ClassFeature` pools. The builder has skill, equipment and spell steps. The compendium has "Spawn on table".
- Renderer: fog memory, greyscale darkvision, exact one-way and terrain walls, and incremental `SceneGraph` redraws instead of full rebuilds. Remaining UI strings go through `t()`.
- Everything uses ATLAS v1.1 tokens and meets WCAG 2.2 AA.

**Traffic and assets (D19, D20, D24)**
- A `tower-http` compression layer negotiates gzip, br or zstd from `Accept-Encoding` and skips already-compressed content types.
- WebSocket compression starts with a spike: standard `permessage-deflate` through a hand-rolled upgrade on `tokio-tungstenite` with its `deflate` feature. If the spike fails, the fallback is app-level deflate negotiated through `Sec-WebSocket-Protocol` (`trame.v1+deflate`), decoded in the browser with `DecompressionStream`. The outcome is recorded in the S3/traffic ADR, and the security reviewer checks BREACH exposure.
- State frames are skipped when the per-recipient projection hash hasn't changed.
- `S3Store` implements the asset store contract for any S3-compatible backend (R2, Silo). When it's configured, the server issues signed GET URLs to the object store. Otherwise, assets stay in Postgres. A one-shot migration copies existing blobs.

**Hosting (D5, D18, D21)**
- Compose prod: Caddy with automatic HTTPS as the only service publishing ports, a Cloudflare Tunnel variant, memory limits on every service, Silo pinned by digest, and a `backup` service (nightly `pg_dump`, 14-day retention, push to R2, optional off-machine copy) with a restore script.
- Terraform:
  - Cloud Run `europe-west9`, request timeout 3600 s, `max-instances = 1`, session affinity, public invoker, Artifact Registry;
  - Neon connection string in Secret Manager (at most 6 secret versions), R2 credentials;
  - a nightly backup Cloud Run job triggered by Cloud Scheduler;
  - a budget alert at 1 EUR.
- ADR-0010 is amended: S3 asset storage with direct downloads, Neon instead of Cloud SQL, and the two hosting targets.

## Testing Decisions

- **A good test** checks externally observable behavior through the highest seam that can see it: HTTP and WebSocket contracts, command results and projected state, the public package API, or the browser. It never asserts private fields or call order. Tests are parametrized, with descriptive case IDs that name the scenario (for example `undo_then_crash_reopens_at_snapshot`, `player_export_forbidden`, `kh_zero_rejected`).
- **Seam 1, browser E2E (Playwright on the production image + Postgres):** extended journeys:
  - owner bootstrap, Host promotion, invite-only redemption by 3 players, and invite revoke;
  - doors, compendium monster spawn, attack with Apply, AoE save-half, condition effects and override, death saves, level-1 caster slots;
  - undo then `kill -9` recovery, restart with map images intact, network drop and reconnect, and a WAL quarantine banner;
  - backup then restore, and compressed responses and WS frames.
  
  Prior art: the current 34-phase GM + player journey behind `make e2e`.
- **Seam 2, server router (Axum + `TableRoomActor`, in-memory and Postgres):** covers:
  - WAL recovery, using a `WalStorage` test double that fails append, snapshot or replay on demand;
  - quarantine, append rollback, correlation ids and actor supervision;
  - `InstanceRole`, owner bootstrap, `CampaignInvite` limits and `InviteRedemption`;
  - export `403`, the zip bomb, rate limiter keys, quotas and the timeline allow-list;
  - per-recipient projections and event filters, and initiative privacy;
  - HTTP compression and WebSocket compression negotiated with a real client.
  
  Prior art: `crates/trame-server/tests/*` (`security_s2_test.rs`, `archive_roundtrip_test.rs`, `postgres_integration_test.rs`, `shutdown_lifecycle_test.rs`).
- **Seam 3, engine commands (`TrameCommand` on `TableState`):** covers Chebyshev cost, difficult terrain, reach, Disengage, cover suggestion, the concentration cap, `SetTokenConditions` and `ConditionOverride` with undo, wall-kind vision and per-token darkvision. Prior art: the parametrized tests in the engine `lib.rs` and `rules.rs`. Shared JSON fixtures keep native and WASM results identical.
- **Seam 4, `dnd5e` public API:** covers derived attacks, spells and features, level-1 casters, rule fixes, the `ClassFeature` catalogue and pools across rests, condition effects and cancellation, the resolution pipeline, monster schema validation, and generator output checks (counts, schema validity, attribution). Prior art: `progression.test.ts`, `rest.test.ts`, `dnd5e.test.ts`.
- **Seam 5, web app (components against a mocked transport):** covers the reconnect state machine and banner, `CommandRejected` toasts, account and invite screens, table controls, the resolution UI, sheets and builder steps, the i18n key parity test, a11y semantics and the impeccable gate. Prior art: `packages/web/tests`.
- **Seam 6, deployment validation (new):** `docker compose config` for the prod stack plus Caddy config validation, `terraform validate` and an offline `terraform plan`, and the restore script exercised inside the E2E backup scenario.
- Gates: each wave must pass `make check`, the extended `make e2e` and CI on its stacked PR (including the `e2e` job and its video artifact). The final gate re-runs the four audits and a manual smoke on both hosting targets.

## Out of Scope

These are tracked as GitHub issues (`needs-triage` + `follow-up`):
- multiclassing;
- map play on phones (the mobile companion stays sheet- and tracker-oriented);
- Wild Shape, summon and Polymorph automation;
- non-SRD mechanics and content;
- realtime delta frames;
- the still-open items from `.cursor/FOLLOWUPS-playable-dnd5e.md`.

Also out of scope: paid hosting tiers, multi-instance horizontal scaling (Cloud Run stays at `max-instances = 1`), public open registration, anonymous guests, persisting the undo ring, languages other than English and French, and the untracked `V2/` folder.

## Further Notes

- This file is the repository-of-record copy of the approved spec, indexed in `ARCHITECTURE.md`. It is not published to the issue tracker. Only the out-of-scope follow-ups become GitHub issues.
- The four wave PRs form one GitHub stack on `dev` (see D26 in the decision log). Each one opens when its wave gate passes. Merging is left to the user.
- Commit bodies cite the audit IDs from the appendix.
- Cost references, last checked 2026-11-05:
  - Cloud Run Tier 1 free compute;
  - Europe egress at about 0.105 USD/GiB from the first byte;
  - Neon free tier in Frankfurt;
  - R2 with free egress;
  - Oracle Always Free at 2 OCPU / 12 GB since June 2026.
  
  Builders recheck them before writing the docs.

## Appendix — Traceability (audit finding to slice)

IDs were assigned when writing this spec. RT1-RT8 and SEC1-SEC9 are the items queued by earlier reviews, in their original order.

**User advocate (UA)**
- UA1 Doors not openable during play: F-A
- UA2 Monsters spawn as 20 HP / AC 10 with no stat block: C-C, S-D, F-B
- UA3 Tokens can't be removed, revealed or hidden from the table: F-A
- UA4 Sheets show no attacks, spells or features: C-B, F-B
- UA5 No AoE targeting from a spell: F-B, E-A
- UA6 No condition UI: F-A, E-A, C-D
- UA7 No concentration UI: F-A, C-A
- UA8 Death saves not evaluated or synced: F-A
- UA9 Fog brush is a placeholder: F-A
- UA10 No wall drawing in the map studio: F-A
- UA11 No zoom or pan: F-A
- UA12 Damage type and critical not selectable: F-A, F-B
- UA13 Builder lacks skill, equipment and spell steps: C-B, F-B
- UA14 Compendium can't spawn a monster: F-B, S-D
- UA15 Darkvision is global, not per token: E-A, F-B, F-D
- UA16 No reconnect or failed-command feedback: F-C1, S-A

**Game systems (GS)**
- GS1 Long rest recovers half the Hit Dice: C-A
- GS2 Critical hits double modifiers: C-A
- GS3 Action's own attack bonus and DC ignored: C-A
- GS4 Concentration DC uncapped (engine and TypeScript): C-A, E-A
- GS5 Level-1 casters have no slots or spells: C-B
- GS6 Token AC wrong and never synced (AC and speed keys): S-D, C-B
- GS7 Thin content (61 spells, 40 monsters): C-C
- GS8 Monster schema lacks multiattack, riders, senses, legendary actions: C-C
- GS9 Mass Suggestion on the wrong class list; concentration flags wrong: C-A
- GS10 Fighting Style feats not offered; Magic Initiate and Skilled have no choices: C-A
- GS11 Euclidean movement instead of Chebyshev; no difficult terrain or reach: E-A, F-A
- GS12 Class skills, equipment and proficiencies missing; armor doesn't feed AC: C-B
- GS13 Class features not automated: C-D
- GS14 Condition effects not applied: C-D, E-A
- GS15 `kh`/`kl` accept `k = 0` and `k > count`: S-B
- GS16 WotC-named test fixtures: C-A

**Realtime (RT)**
- RT1 One reaction-prompt audience for state and events: S-D
- RT2 `PointerPing` validation, rate limit, bounded outbound channels: S-D
- RT3 Undo then crash locks the campaign; MCP staging not in the WAL; no crash-recovery test: S-A
- RT4 `speed_remaining_ft` and `ActionRefunded` leak to non-controllers: S-D
- RT5 No rollback on WAL append failure; snapshot failure is fatal: S-A
- RT6 `TokenRemoved` and controller-only events not filtered by visibility: S-D
- RT7 Initiative rolls broadcast before commit and leak hidden tokens: S-D, S-B
- RT8 HP in `TokenHealed`/`DamageApplied`, caster in `AoeCleared`, `active_reaction_prompts` not filtered per recipient: S-D
- RT9 Dead room actor handle never removed: S-A
- RT10 `CommandRejected` without correlation id on some paths: S-A, F-C1
- RT11 No client auto-reconnect, heartbeat or status banner: F-C1
- RT12 Full state frames sent even when nothing changed: S-E

**Security and hosting (SEC)**
- SEC1 Zip bomb and duplicate entry names on import: S-B
- SEC2 Players can export the campaign with GM secrets: S-B
- SEC3 Players choose their own initiative: S-B
- SEC4 Rate limiter bypassable (keys, success counting, proxies, IPv6, bind routes): S-B
- SEC5 Hardcoded fallback keys; dev secrets accepted outside dev: S-B
- SEC6 Import copies the whole body; no per-account import limit: S-B
- SEC7 Invite TTL uncapped, no max uses or revoke: S-B, S-C, F-C1
- SEC8 No tests for live secret-door masking: S-B
- SEC9 Role checks bypass `resolve_campaign_role`; timeline lacks an allow-list: S-B
- SEC10 Open public registration; no instance-level roles: S-C, F-C1
- SEC11 Random instance id breaks map images on restart: S-C
- SEC12 `DATABASE_URL` optional, silent in-memory mode: S-C
- SEC13 Removed members keep live sockets: S-C
- SEC14 Image decode and argon2 block the async runtime; no pixel or storage quotas: S-B
- SEC15 Raw DB errors reach clients; `/healthz` doesn't check Postgres: S-B
- SEC16 Legacy `assets/*.webp` from archives not persisted: S-B
- SEC17 No TLS edge; internal ports published; no trusted-proxy config: I-A, I-B
- SEC18 No backups and no tested restore: I-A, I-B, I-C
- SEC19 Cloud Run template depends on non-free Cloud SQL; no free path or cost docs: I-B, I-A, D-A
- SEC20 No HTTP or WebSocket compression; assets proxied through the server: S-E

## Decision log (grill rounds 1-4, 2026-11-05)

**Accounts and access**
- D1 `InstanceRole` (`Owner`, `Host`, `Member`), distinct from the per-campaign `UserRole`. Only `Host` and `Owner` create campaigns. Only `Owner` promotes accounts.
- D2 No pure guest sessions. `InviteRedemption` creates a `Member` account or binds an existing one. Existing guests get a bind prompt. Replaces `GuestSessionUpgrade`.
- D3 `CampaignInvite`: one link per campaign, max uses (default 8), TTL <= 7 days, revocable, GM sees who redeemed.
- D15 First boot without an `Owner` logs a one-time setup URL valid 1 h; optional `TRAME_BOOTSTRAP_OWNER_EMAIL` locks the email.
- D16 TOTP optional for everyone, recommended in the UI (account settings nudge, stronger for `Owner`).

**Robustness**
- D4 WAL recovery: snapshot right after `UndoLastAction`; a replay failure opens the room at the last good state, moves failing entries to `QuarantinedWalEntry`, and shows the GM a banner. Undo history stays in memory (lost on restart, documented).

**Gameplay automation**
- D6 Semi-automated resolution: to-hit vs target AC, damage roll, then an explicit Apply (damage type, critical) by the attacker or GM. AoE shows the affected tokens with save / save-half controls. `pipeline.ts` is fixed and wired.
- D7 Staged monsters copy the full stat block into the scene at staging time (homebrew-editable). Server validates bounds. Tokens stay `SyntheticToken`.
- D8 Full SRD 5.2.1 content generated by a committed, reproducible script from the Open5e SRD 5.2 dataset (pinned snapshot), CC-BY-4.0 attribution shipped, sampled review by the game-systems reviewer.
- D9/D12 `ClassFeature` = `ResourcePool` + `ActiveEffect`, levels 1-20, 12 classes + 12 SRD subclasses. Automated when it changes a number or a roll rule (Rage, Extra Attack, Unarmored Defense, Sneak Attack, Divine Smite, advantage flags...). Profile replacements (Wild Shape, summons, Polymorph) stay manual with counters.
- D13 Conditions apply their roll effects automatically (advantage/disadvantage cancel per SRD). `ConditionOverride`: the GM can force or remove any condition or effect on any token, linked or synthetic.
- D14 Also in scope: cover suggestion from walls (GM confirms), difficult terrain painted in the studio, weapon reach, Disengage, Magic Initiate and Skilled choices, `kh`/`kl` keep-count validation, rename WotC-named test fixtures.

**Hosting and traffic**
- D5/D18 Two documented targets:
  - Primary "near-free": Cloud Run `europe-west9` (Paris, Tier 1 free compute) + Neon free (Frankfurt) + Cloudflare R2, budget alert at 1 EUR. Card required; Europe egress billed from the first byte (about 0.105 USD/GiB), kept to cents by compression and direct R2 downloads.
  - "Strictly 0 EUR": the prod Compose + Caddy on an Oracle Always Free VM (2 OCPU / 12 GB since June 2026; idle reclamation and capacity risks documented) or on a home machine behind Cloudflare Tunnel.
- D19 S3-compatible asset storage (amends ADR-0010): when configured (R2 on Cloud Run, optional on VPS), assets go to S3 and browsers download them by signed URL directly; otherwise Postgres as today.
- D20 Compression: every HTTP response honours `Accept-Encoding` (gzip/br/zstd middleware, images and fonts skipped); the WebSocket negotiates compression; state frames are skipped when nothing changed for that recipient. Delta frames are a tracked follow-up.
- D24 WebSocket compression: first a spike on standard `permessage-deflate` via a hand-rolled upgrade on `tokio-tungstenite` with its `deflate` feature (axum 0.8.9's extractor cannot negotiate it). Fallback: app-level deflate negotiated through `Sec-WebSocket-Protocol` (`trame.v1+deflate`) with the browser `DecompressionStream`. No third-party WebSocket crate. Security reviewer checks BREACH exposure.
- D21 Nightly `pg_dump`, 14-day retention, pushed to R2 (Cloud Run: Cloud Run job + Cloud Scheduler; VPS: `backup` container with optional off-machine copy). Restore script tested in E2E.

**Process**
- D10/D23 Waves W0 to W3 each produce one PR, green on `make check` + `make e2e`.
- D26 (2026-11-05, supersedes "ask before each PR") The PRs are stacked with `gh stack` on trunk `dev` and opened as soon as each wave gate passes. Every PR shows its test results and links its E2E video. Only the user merges.
- D17/D22 Out-of-scope items become GitHub issues (`needs-triage` + `follow-up`): multiclassing, map on phones, Wild Shape/Polymorph automation, non-SRD mechanics, realtime delta frames, plus still-open items from `.cursor/FOLLOWUPS-playable-dnd5e.md` (file removed once migrated).
- D25 Glossary terms and ADRs below are written first (W0).
