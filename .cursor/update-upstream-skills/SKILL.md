---
name: update-upstream-skills
description: >-
  Refresh vendored third-party Cursor skills under .cursor/skills from their
  upstream git sources. Use when the user asks to update Matt Pocock skills,
  grill-with-docs, to-spec, or pull the latest upstream agent skills.
---

# Update upstream skills

Run from the repo root (needs git + network):

```bash
make update-upstream-skills
```

That reads `.cursor/skills/upstream.json` and replaces only the listed directories under `.cursor/skills/`. Codex `agents/openai.yaml` files are stripped on copy; Cursor uses `SKILL.md`.

Do not hand-edit upstream skill files. To add or drop a vendored skill, edit the manifest, then rerun.

First-party skills (`orchestration`, `e2e-testing`, `anti-pattern-scan`, `update-upstream-skills`, `hub-ticket-flow`) are not in the manifest and must not be overwritten.

After a successful run, show the diff under `.cursor/skills/` and do not commit unless asked.
