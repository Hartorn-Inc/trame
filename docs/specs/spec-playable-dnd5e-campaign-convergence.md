# Specification: Playable D&D 5e Campaign, Whole Application (v3)

- **Identifier**: `spec-playable-dnd5e-campaign-convergence`
- **Version**: v3 (supersedes the earlier narrower convergence spec; removes the scope cap)
- **Status**: Ready for Agent (`ready-for-agent`)
- **Related ADRs**: `ADR-0001` (with its single-evaluator amendment), `ADR-0002`, `ADR-0004`, `ADR-0010`, `ADR-0011`, `ADR-0034`, `ADR-0035`, `ADR-0036`, `ADR-0037`
- **Glossary**: every domain term below is defined in `GLOSSARY.md`.

---

## Problem Statement

A Game Master who wants to run a full D&D 5e campaign in TRAME can't today:
- **The server doesn't compile.**
- **Core routes are missing:** campaigns, actors, notes, dice, assets, map import, MCP.
- **The frontend isn't wired to a real backend:** the dev proxy targets the wrong port, there's no lobby or auth screen on `dev`, the WASM engine is never loaded, and the production image ships no frontend.
- **Players can cheat or see secrets:**
  - spoofed roles in query parameters;
  - every new account is a GM;
  - enemy HP/AC and secret doors are visible;
  - the timeline is unauthenticated;
  - export leaks other campaigns.
- **Several rules are wrong:** Warlock subclass level, long rest reviving the dead, no retroactive CON HP, duplicate effects, no opportunity-attack prompts, client and server stats that disagree.
- **Persistence gaps:** the archive ignores Postgres, rooms never hibernate, dice never reach the timeline.
- **Half the docs are in French** and contradict the code.

---

## Solution

One branch delivers a compiling, hardened, tested application. With it, a GM can:
- register, create a campaign, and invite players with a single `?invite=` link;
- build characters from a curated SRD;
- upload portraits and import UVTT maps, then activate a scene;
- run turn-by-turn combat with walls, reactions, damage, rests and level-ups;
- let an MCP assistant stage encounters;
- export and import the campaign.

Players get a 1-click join, a sheet that persists safely through REST, a live table over WebSocket, and a mobile companion. They see only a `PublicTokenView` of what they don't control. One Rust engine, compiled to WASM, is the single source of truth for formulas and geometry on both client and server. Docs are English, consistent with the code, and the UI is fully localized in English and French. CI runs every test suite, including Postgres and WASM. The production image serves the SPA and API from one binary.

---

## User Stories

**Account, campaign, onboarding**
1. As a visitor, I want to register with email and password, so that I can own campaigns.
2. As a registered user, I want my account to start as a regular user (`PLAYER` global role), so that being a GM is only a per-campaign fact.
3. As any non-guest user, I want to create a campaign and become its GameMaster, so that I can start preparing.
4. As a user with TOTP enabled, I want login to require my 6-digit code, so that a stolen password is not enough.
5. As a user, I want repeated failed login, TOTP or magic-link attempts to be throttled, so that brute force is impractical.
6. As a GameMaster, I want to mint an invite link for my campaign (and only mine), so that I control who joins.
7. As an invited player, I want opening `?invite=<jwt>` to log me straight into the `CampaignWorkspace` as a guest (`GuestSessionUpgrade`), so that I join in seconds.
8. As a player who is already logged in, I want an invite to attach the campaign to my existing account, so that I don't get a duplicate guest user and lose my characters.
9. As a returning user, I want my session restored on page load (`/auth/me`), so that I don't log in every time.
10. As a self-hoster on a LAN over plain HTTP, I want to turn off the `Secure` cookie flag explicitly, so that I can log in without TLS.

**Characters and sheets**
11. As a player, I want a character-creation flow (species, class, background, abilities, equipment) that produces a complete `Actor`, so that I can play right away.
12. As a player, I want my sheet edits to save with optimistic concurrency (`expected_version`, `409` on conflict), so that two editors never silently overwrite each other.
13. As a player, I want a successful save to broadcast `ActorUpdated` and update my `LinkedActorToken` on the table, so that the table matches my sheet.
14. As a player, I want sheet changes kept out of the GM's tactical undo stack, so that GM undo only affects table actions.
15. As a player, I want derived stats (AC, saves, skills, spell DC, initiative) computed by the same engine the server uses, so that client and server never disagree.
16. As a Barbarian or Monk, I want unarmored defense to win when it beats my armor ("best wins"), so that my AC is correct.
17. As a player, I want same-named effects not to stack, with the strongest applying, so that buffs follow 5e rules.
18. As a player, I want level-up from 1 to 20 for all 12 SRD 5.2.1 classes, with every class choosing its subclass at level 3 and martial classes gaining Weapon Mastery, so that progression is correct (Decision G10, ADR-0038).
19. As a player raising Constitution with an ASI, I want my max HP to increase for every earlier level, so that HP follows 5e rules.
20. *Dropped by Decision G10:* the Tough feat is not in SRD 5.2.1. Backgrounds grant the ability score increase (+2/+1 or +1/+1/+1) and an Origin feat instead.
21. As a level-11+ caster, I want spells available to choose at every spell level I can cast, so that level-up is never blocked.
22. As a player, I want level-up HP rolls and rest hit-dice rolls made by the server (`POST /dice/roll`, `ChaCha20Rng`), even when the table room is asleep, so that rolls are fair and always available.
23. As a player, I want a short rest to spend hit dice and recover short-rest resources and Pact Magic, so that resources refresh correctly.
24. As a player, I want a long rest to restore HP, half my hit dice, slots and resources, and reduce exhaustion by one level (SRD 5.2.1: -2 per level on d20 Tests, -5 ft Speed per level, death at level 6), but never revive a dead character, so that death stays meaningful.
25. As a player, I want conditions referenced by stable ids (for example `unconscious`) and shown in my language, so that rules and UI agree.

**Compendium**
26. As a GM or player, I want a curated SRD 5.2.1 (12 classes, 9 species with no ability score increases, 4 SRD backgrounds plus 2 original ones, the 17 SRD feats, about 60 spells from cantrips to 9th level, about 40 items, about 35 monsters from CR 0 to 20), so that a campaign can run without homebrew.
27. As a GM, I want campaign homebrew to override instance and SRD entries, so that I can customize content.
28. As a French-speaking table, I want compendium names and descriptions in French, so that we can play in French.

**Maps, assets, scenes**
29. As a GM, I want to upload map images and portraits, and have them served through signed URLs only to campaign members, so that assets are private.
30. As a GM, I want to import `.uvtt`/`.dd2vtt` maps with walls, doors and lights, with oversized or malformed images rejected before decoding, so that map prep is fast and safe.
31. As a GM, I want to activate a scene and keep `HeroToken`s while staged tokens spawn, so that moving between scenes is one click.
32. As a GM, I want secret doors, hidden walls and hidden tokens to stay invisible to players, including in live events, so that surprises are preserved.

**Live table and combat**
33. As a player, I want to move my token and be blocked by walls, so that the map is enforced.
34. As a player leaving a hostile creature's reach, I want my token to stop on the exit square while the reactor's owner decides on an opportunity attack, so that reactions work. If they pass, my move continues.
35. As a GM, I want to force `Pass` on any pending reaction, so that the table never deadlocks.
36. As a GM, I want to start combat with server-rolled initiative, with hidden tokens excluded from public rolls and players allowed to roll their own, so that initiative is fair and doesn't leak.
37. As a player, I want the combat tracker to show only combatants I can see, with the active turn indexed correctly for me, so that hidden enemies are not inferred.
38. As a GM, I want the tracker to show initiative totals that I can adjust, so that I can resolve ties and late joiners.
39. As a GM, I want to apply damage and healing to any token, so that I can run monsters.
40. As a player, I want to apply damage and healing only to my own tokens, so that players can't tamper with others.
41. As anyone applying damage, I want resistances, immunities and vulnerabilities taken from the target's real data, so that typed damage can't be spoofed.
42. As a GM damaging a creature at 0 HP, I want a death-save failure recorded (two on a critical hit), and instant death on massive damage, so that dying follows 5e rules.
43. As a GM, I want damaging 1 of 4 synthetic goblins to affect only that goblin, so that compendium monsters are independent.
44. As a GM, I want damage to a `LinkedActorToken` to persist to the `Actor`, so that wounds survive the session.
45. As a player, I want to see enemies only as a `PublicTokenView` (name, portrait, position, size, visible conditions, `BloodiedState`), so that numbers stay secret.
46. As a GM, I want to undo the last tactical action, including a whole committed MCP batch in one step, so that mistakes are cheap.
47. As a GM, I want AoE templates clipped by walls, and to clear them, and to refund a mistaken action, so that tactical play is smooth.
48. As a player, I want table dice rolls broadcast live and recorded in the session timeline, so that everyone sees results and they can be replayed.
49. As a GM, I want idle rooms to hibernate after 15 minutes with no connections (heartbeat pings don't count as activity), with state snapshotted, so that hosting stays cheap and nothing is lost.
50. As a GM, I want the server to shut down gracefully on SIGTERM and flush state, so that deploys don't lose data.

**Notes, handouts, journal**
51. As a player editing a `PARTY` note, I want my edit merged without exposing or deleting GM `:::dm` blocks, so that GM secrets stay intact (`LineAnchorNoteMerge`).
52. As a GM, I want to reveal a handout to the table, so that players receive it live.
53. As a player, I want a party journal shared with my group, so that we keep campaign notes together.

**MCP assistant**
54. As a GM, I want an MCP client authenticated with a `trame_pat_` token to list tools generated from the real command schema, and to read timeline and notes resources by session and cursor, so that assistants have accurate context.
55. As a GM, I want staging mode as a campaign setting, so that assistant actions appear as ghost previews until I `[ Commit All ]` or `[ Reject ]`.
56. As a GM, I want a non-staged assistant batch to apply all or nothing, so that the table is never left half-changed.

**Archive**
57. As a GM, I want to export my campaign (Postgres-backed actors, notes, scenes, assets) to a `.trame` file containing only my campaign's data, so that I can back it up.
58. As a GM, I want importing a `.trame` file to create a new campaign that I own, with fresh IDs and protection against oversized or zip-bomb archives, so that imports are safe and never overwrite anything.

**Workspace, mobile, design, accessibility, language**
59. As a GM, I want a 5-tab workspace (Table, Maps, Actors, Documents, Compendium) with slide-over HUD drawers on the table, so that prep and play live in one place.
60. As a phone user, I want a mobile companion with working Sheet, Dice, Inventory, Tracker and Journal tabs and touch targets of at least 44x44 px, so that I can play from my phone.
61. As a user, I want the UI fully available in English and French, with my language detected and switchable, so that I can play in my language.
62. As a low-vision user, I want WCAG 2.2 AA contrast in both themes, including canvas walls and turn indicators, so that I can read the table.
63. As a keyboard user, I want proper button semantics and focus traps in modals, so that I can play without a mouse.

**Operations and contributors**
64. As an operator, I want the server to refuse to start without the required secrets (unless `TRAME_ENV=dev`), listing what's missing, so that production never runs on default keys.
65. As an operator, I want one production image serving the SPA, API and WebSocket on port 8080, with structured logs, so that deployment is a single container.
66. As an operator, I want security headers, WebSocket message size limits and `Origin` checks, so that the browser attack surface is reduced.
67. As a contributor, I want `make test` and CI to run the Rust, WASM parity, web, game-systems and Postgres tests, so that nothing ships untested.
68. As a contributor, I want all specs, ADRs and the architecture doc in English, consistent with the code and glossary, with ADR supersession links in both directions, so that docs can be trusted.

---

## Implementation Decisions

- **State boundary (ADR-0037):** persistent `Actor` changes go through REST with `expected_version` and broadcast `ActorUpdated`, with no `UndoEntry`. Tactical changes go through `TrameCommand` and push an `UndoEntry` to the 50-entry ring. Only `LinkedActorToken`s sync with their `Actor`. `SyntheticToken`s keep state in `TokenState`.
- **Dice:** sheet-driven rolls use REST `POST /api/v1/campaigns/{id}/dice/roll` (works while the room is hibernated, appended to the table log when the room is awake). Table rolls use WebSocket `RollDice`. Both use the server `ChaCha20Rng`, with bounded expression length, term count and checked arithmetic.
- **Commands:** add `HealActor`, `ActivateScene`, `ClearAoE`, `RefundAction` and, if needed, `RevealHandout`. The code names (`AdvanceTurn`, `SetAmbientLighting`) are canonical. `CommitMcpStaging` and non-staged MCP batches are atomic: snapshot, apply all, or roll back, producing one composite `UndoEntry`.
- **Reactions (G2):** `MoveToken` detects leaving a hostile's reach, stops on the exit square, and opens a `ReactionPrompt` for the reactor's owner. There's no timer, and the GM can force `Pass`. `DecideReaction` validates the prompt before pushing undo.
- **Rules engine:** `ActiveEffect` phases are `Base -> Add -> Multiply -> Override -> ClampMin/ClampMax`. The base phase is exclusive and evaluates each candidate formula, keeping the maximum. Same-named effects keep the largest magnitude. Unknown formula variables are an error. Damage at 0 HP adds death-save failures. `Vulnerable` uses saturating math.
- **Single evaluator (G1, ADR-0001 amendment):** the engine exports `wasm-bindgen` bindings for formula evaluation (`derivedDAG`), the visibility polygon, AoE and the move preview with wall collision, built for the web and for Node. The frontend bridge loads it asynchronously and the duplicate TypeScript geometry is removed. `computeDnd5eSheetDerived` keeps its signature and delegates to WASM, and formula rules move into `system.json`. The D&D procedures (level-up, rest, damage orchestration, builder) stay in TypeScript.
- **Identity and authorization (G4):** no identity or role is taken from query parameters. Roles come only from campaign membership. The global role defaults to `PLAYER` and grants nothing. Invites are minted only by `POST /api/v1/campaigns/{id}/invites` (GM of that campaign, invite secret of at least 32 bytes), with the URL `{TRAME_PUBLIC_ORIGIN}/...?invite=`. `/auth/invites` and `/auth/magic-link/mint` are removed. Magic-link redemption reuses an existing session.
- **Player projection (G5):** non-controlled tokens are projected as a `PublicTokenView` with a `BloodiedState` (`Unhurt` above 50% HP, `Bloodied` at 50% or below, `Down` at 0). Secret door, hidden wall, AoE-affected and hidden-token events are filtered per recipient. `active_turn_index` is re-indexed per recipient, and initiative excludes hidden tokens from public rolls.
- **Damage authority (G6):** the GM can target any token, players only their own. Affinities come from the target's server data.
- **Secrets (G7):** startup fails closed when the TOTP, asset, presign or JWT keys are missing, unless `TRAME_ENV=dev`. No auto-generation.
- **Transport hardening:** per-IP and per-account rate limits on login, register, TOTP and magic link; `TRAME_COOKIE_SECURE` (default on); security headers (CSP, `nosniff`, `frame-ancestors`); WebSocket max message size and `Origin` allow-list; standard `sha2`/`hmac` crates instead of the hand-written ones.
- **Persistence:** with Postgres configured, actors, notes, scenes, the archive and the presign membership all use `SqlxPostgresStore`. Save errors are propagated, never ignored. Dice and initiative events go to the WAL and timeline, and initiative totals are stored in table state. A background interval sweeper hibernates rooms with no connections after the 15-minute `Idle-Lease` (pings don't renew it) and snapshots the WAL.
- **Archive (G8):** export is filtered by campaign. Import streams entries with total and per-entry uncompressed byte caps and always creates a new campaign owned by the caller, with remapped IDs.
- **Assets and maps:** authenticated upload and signed `GET` routes. A GM-only UVTT import route reuses the existing importer with its pre-decode dimension guard. The engine's `WallSegment` is the only wall type.
- **MCP:** JSON-RPC 2.0 at `POST /api/v1/mcp` with `trame_pat_` auth. The tool input schemas are generated from `TrameCommand`. Staging mode is a persisted campaign setting. The timeline resource reads session and cursor from the URI.
- **Frontend:** the API client handles `PointerPing` tagging, full `CommandAccepted.state` reconciliation, `ActorUpdated`, `HandoutRevealed` and `McpStagingProposed`. `App.tsx` runs `GuestSessionUpgrade` before the auth guard. The 5-tab `CampaignWorkspace`, `HudDrawers`, `TableCanvas`, `GmOverrideToolbar` (with MCP commit/reject), `CombatTrackerBar` and `MobileCompanionView` are all wired to real data. Everything is built on ATLAS v1.1 tokens.
- **Localization (G3):** every UI string goes through `t()`, with English canonical and a complete French dictionary. French appears only in localization dictionaries and bilingual compendium metadata.
- **Game-system fixes (S5, rebased on SRD 5.2.1 by Decision G10 / ADR-0038):** every class takes its subclass at level 3 and must choose it then; long rest never revives the dead; a CON ASI applies retroactively; condition ids instead of localized literals; one proficiency-bonus function; one `sheetLayout`.
- **Docs (G9):** translate in place to English and align with code terms. One root architecture doc. ADR-0012 marked superseded by ADR-0036. Glossary-avoided terms removed from code and docs.
- **Packaging:** the production image builds WASM, the web bundle and the server (with the lockfile copied), and the Axum server serves the SPA with an `index.html` fallback. `tracing-subscriber` handles logs. The Rust toolchain is pinned. CI runs WASM, Postgres and game-systems tests.

### Grill Decisions (v3, all accepted)

- **G1** The WASM `evaluate_derived_dag` is the only formula evaluator. `computeDnd5eSheetDerived` keeps its signature and delegates to it, and formula rules move into `system.json`. Recorded as an amendment to ADR-0001 (decision 6 is also marked superseded by ADR-0037).
- **G2** Opportunity attacks: the token stops on the square where it leaves reach. The prompt goes to the reactor's owner (GM for monsters), with no timer. The GM can force `Pass`, and movement resumes on `Pass` or after resolution.
- **G3** Every UI string goes through `t()`, with English canonical and a complete French dictionary.
- **G4** The global user role grants nothing and defaults to `PLAYER`. Any non-guest account can create a campaign and becomes its GM. All checks use the campaign role.
- **G5** Players get a `PublicTokenView` for tokens they don't control: name, portrait, position, size, visible conditions, and `BloodiedState` (`Unhurt`/`Bloodied`/`Down`). No AC or HP numbers.
- **G6** The GM applies damage and healing to any token. Players only to their own tokens. Resistances, immunities and vulnerabilities always come from the target's server-side data.
- **G7** Missing secrets: the server refuses to start and lists the missing variables, unless `TRAME_ENV=dev` (set in `docker-compose.dev.yml`). No key auto-generation.
- **G8** A `.trame` import always creates a new campaign owned by the importer, with all IDs rewritten.
- **G9** Specs are translated in place with no French copies kept. ADR-0012 is marked superseded, not deleted. The code command names are canonical.

---

## Testing Decisions

- **A good test** exercises externally observable behavior through the highest available seam: the HTTP/WebSocket contract, the command result and the projected state, or the public package API. It never inspects private fields or call order. Tests are parametrized with descriptive case IDs that name the scenario.
- **Seam 1, Engine command seam:** apply a `TrameCommand` to `TableState` and assert the resulting state, events and undo stack. This covers the rules engine, reactions, MCP atomicity, damage authority, linked vs synthetic tokens, and composite undo. Prior art: the existing parametrized tests in the engine `lib.rs`/`rules.rs`.
- **Seam 2, Server router seam:** the full Axum router plus `TableRoomActor` (in-memory and Postgres-backed). This covers auth, invites, rate limits, the cookie flag, timeline auth, export scoping, the zip bomb, import ownership, actor `409`, notes merge, MCP, the UVTT route, asset routes, the sweeper, Ping vs lease, the per-recipient projection, and graceful shutdown. Prior art: the router tests in the server `lib.rs` and `tests/archive_roundtrip_test.rs`.
- **Seam 3, Game-system public API:** the exported functions of the D&D 5e package (derived stats through WASM, level-up, rests, damage pipeline, compendium resolver). Prior art: `progression.test.ts`, `rest.test.ts`, `dnd5e.test.ts`.
- **Seam 4, Web app seam:** rendered components and app bootstrap against a mocked transport. This covers session restore, `GuestSessionUpgrade`, workspace tabs, token selection, sheet save over `PUT`, dice routing, mobile tabs, a11y semantics, the i18n key parity test, and the impeccable gate. Prior art: the `packages/web/tests` component tests.
- **Cross-seam parity:** shared JSON fixtures evaluated by native Rust and by WASM must match exactly.
- **Live smoke (manual):** the full session walk-through in the browser against `make up` with Postgres, plus the production image serving the SPA and API.

---

## Out of Scope

- New game systems other than D&D 5e, and SRD content beyond the curated set.
- Payment, multi-tenant hosting control panels, and native mobile apps.
- Real-time collaborative CRDT editing of notes beyond `LineAnchorNoteMerge`.
- Languages other than English and French.

---

## Further Notes

- The architectural boundary between persistent `Actor` sheet mutations (`PUT /api/v1/campaigns/{id}/actors/{actor_id}` with `expected_version` optimistic locking) and tactical `TokenState` mutations (`TrameCommand` + 50-entry `UndoEntry` ring buffer) is recorded in `docs/adr/0037-actor-rest-vs-token-trame-command-boundary.md`.
- The single WASM formula evaluator (G1) is recorded as an amendment to `docs/adr/0001-*`.
