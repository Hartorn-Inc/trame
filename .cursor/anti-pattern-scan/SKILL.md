---
name: anti-pattern-scan
disable-model-invocation: true
description: >-
  Scan the codebase for performance, architecture, and data-fetching anti-patterns
  in the Vite/TanStack frontend and FastAPI backend. Use when asked to audit code quality,
  find anti-patterns, review performance, or check for inefficient data loading.
---

# Anti-Pattern Scanner

Detect common performance and architecture anti-patterns in the LLM Hub codebase. Works by running targeted Grep/Glob searches and classifying findings.

For the full pattern catalog with detection queries and examples, see [patterns.md](patterns.md).

## Agent Behavior Rules

1. **Run all detection searches in parallel** — patterns are independent.
2. **Classify each finding** by severity: CRITICAL (breaks at scale), WARNING (degrades perf), INFO (code smell).
3. **Check for false positives** — read 5-10 lines of context around each match before reporting.
4. **Never auto-fix** — present findings and wait for the user to decide.

## Workflow

### Step 1 — Choose scope

Ask the user (or infer from context):
- **Full scan**: all categories
- **Frontend only**: data fetching, component, caching patterns
- **Backend only**: query, transaction, service layer patterns
- **Specific file/directory**: targeted scan

### Step 2 — Run detections

For each anti-pattern category, run the Grep/Glob searches listed in [patterns.md](patterns.md). Run all searches within a category in parallel.

### Step 3 — Validate findings

For each match:
1. Read surrounding context (10 lines before/after)
2. Check if it's a known exception (test files, migrations, scripts)
3. Discard false positives using the guidance in each pattern's **Validate** section

### Step 4 — Report

Present findings grouped by severity, then by category:

```
## CRITICAL

### [F1] Client-side full data load on unbounded entity
- **File**: `frontend/src/app/p/[projectId]/evaluations/page.tsx:42`
- **Pattern**: `useDataTable` used for evaluations list (can grow unbounded)
- **Fix**: Migrate to `useServerDataTable` with backend pagination
```

Include counts: `Found: 3 CRITICAL, 5 WARNING, 2 INFO`

### Step 5 — Suggest next steps

For CRITICAL findings, propose concrete migration steps. For WARNING, note them for future work. For INFO, mention only if the user asks for details.
