# Issue tracker: GitHub (`Hartorn-Inc/trame`)

Issues, specs, and Wayfinder maps for this repo live as GitHub issues on `Hartorn-Inc/trame`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --repo Hartorn-Inc/trame --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo Hartorn-Inc/trame --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --repo Hartorn-Inc/trame --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh api --method POST repos/Hartorn-Inc/trame/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (database id, as in **Blocking** below).
- **Comment on an issue**: `gh issue comment <number> --repo Hartorn-Inc/trame --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo Hartorn-Inc/trame --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo Hartorn-Inc/trame --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `Hartorn-Inc/trame`.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --repo Hartorn-Inc/trame --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a sub-issue of a parent**). Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/Hartorn-Inc/trame/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/Hartorn-Inc/trame/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --repo Hartorn-Inc/trame --state open`, scoped to the map's sub-issues), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --repo Hartorn-Inc/trame --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --repo Hartorn-Inc/trame --body "<answer>"`, then `gh issue close <n> --repo Hartorn-Inc/trame`, then append a context pointer (gist + link) to the map's Decisions-so-far.
