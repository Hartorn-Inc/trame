---
name: hub-ticket-flow
description: >-
  Run a Linear ENG issue through Hub builders/reviewers plus Pocock
  grill/spec/tickets/TDD/spec-review/retro. Use when the user assigns Cursor
  to a ticket, says implement ENG-XXXX, or asks to work a spec or ticket.
---

# Hub ticket flow

One dispatcher: **you (the main agent)**. Pocock skills decide *what* and *whether it matches the spec*. Hub named agents write and criticise *this codebase*.

Do **not** run `/implement` or `/implement-spec`. Those spawn generic coders and fight this roster.

Linear: `docs/agents/issue-tracker.md`. Vocabulary: `GLOSSARY.md`. ADRs: `docs/adr/`.

## 0. Fetch and classify

`get_issue` on the ENG id. Read the body, parent, `blockedBy` / `blocks`.

| What you fetched | Do |
|---|---|
| Blocked by an open issue | Stop. Report blockers. |
| Fuzzy request, no spec | `/grill-with-docs`. Do not code. |
| Spec, no tickets, one session | Phase 2. |
| Spec, user wants slices | `/to-tickets` on the spec, then Phase 2 on the **frontier** ticket (no open blockers). |
| Child ticket | Phase 2 for **this ticket only**. Fetch the parent spec; do not implement sibling tickets. |
| UI/UX in scope, no design brief | **user-advocate** design gate, then Phase 2. |

## 1. Seams (then TDD)

`tdd` is the **coding loop**, not an agent and not a replacement for builders.

If the spec already lists testing seams, use those — do not re-interview. Otherwise propose seams (highest public boundary, as few as possible) and wait for a yes.

Every builder prompt must include: `.cursor/skills/tdd/SKILL.md`, the seam list, and Hub test commands (`make test` / path-scoped pytest, not host `uv run` for backend).

Loop, one slice at a time:

1. **Red** — builder writes one failing test at an agreed seam (public behaviour, glossary words, no internals).
2. **Green** — same builder writes only enough production code to pass it.
3. Repeat. Do not batch all tests first. Refactor is **review**, not this loop.

Hub pytest / Playwright conventions still apply (`testing-patterns.mdc`). `tdd` decides *order and seam*; Hub docs decide *how tests look*.

## 2. Implement (Hub builders)

Route by files, not by a generic implementer:

| Touch | Builder |
|---|---|
| Backend Python, API, tenancy, migrations | `backend-builder` |
| LLM prompts / structured generation | `prompt-engineer` |
| Frontend | `frontend-builder` (after user-advocate if UI) |
| Docker, Helm, Makefile, CI | `devops-helper` |

You own integration. Builder prompt = Linear spec URL + ticket + glossary + ADRs + seams + **follow `tdd`**. You merge conflicts; builders do not.

Parallel builders only when work does not share files. Same-domain work stays serial.

## 3. Review (parallel, two kinds)

After a substantive diff, dispatch **together**:

1. **Hub reviewers** from the matching table in `.cursor/rules/orchestration.mdc` (file paths → `clean-arch-guard`, `frontend-reviewer`, `security-auditor`, …).
2. **Pocock Spec axis** (`code-review`): diff vs the originating Linear spec/ticket. Missing / extra / wrong behaviour only.

Skip Pocock **Standards** axis. Hub reviewers already own conventions; Fowler-smell review duplicates them.

Triage: MUST FIX / CRITICAL before anything else. Re-run the same reviewers on the fix diff if you changed behaviour.

## 4. Ship

Commit only if the user asked. PR body: `pr` skill, without fighting `.github/pull_request_template.md` or label gates.

Do not close the Linear parent spec. Resolve a child ticket the way the tracker doc says only when the user asked to.

## 5. Retro

Load `retro` at the end if navigation was painful, a check should have caught a mistake, or the user asked. Otherwise skip.
