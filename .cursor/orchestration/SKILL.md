# Orchestration Playbook

When the user assigns Cursor to a Linear ticket or says implement `ENG-XXXX`, follow `.cursor/skills/hub-ticket-flow/SKILL.md` first.

Step-by-step guide for delegating work to agents.

## 1. Planning Phase

Before delegating, understand the full scope:

1. Identify which files/domains are affected
2. Decide which builder(s) and reviewer(s) are needed (see roster in `orchestration.mdc`)
3. For UI features: start with user-advocate design gate

## 2. Delegation to a Builder

When dispatching a builder agent:

1. **Read the agent definition** (`.cursor/agents/<agent>.md`) to understand its scope
2. **Prepare a detailed prompt** including:
   - What to build (feature description, requirements)
   - Which files to modify or create
   - Any constraints or dependencies
   - Related existing code to reference
3. **Dispatch** via the Task tool
4. **Review the result** before accepting -- you are responsible for integration

## 3. Review Workflow

After substantive changes, invoke the appropriate reviewer(s):

1. **Identify reviewers** based on files changed (see matching table in `orchestration.mdc`)
2. **Dispatch reviewers in parallel** -- they are independent and can run concurrently
3. **Prepare each reviewer prompt** with:
   - What was changed and why
   - Specific files to review (paths, line ranges)
   - Any known trade-offs or intentional deviations
4. **Triage findings** by severity:
   - CRITICAL: must fix before proceeding
   - HIGH/WARNING: should fix, discuss with user if trade-off
   - MEDIUM/LOW/INFO: address if time permits, note for future

## 4. UI Feature Design Loop

For features that affect the user interface:

### Step 1: Design Gate (user-advocate)
- **With mockup**: dispatch **user-advocate** to validate it against Priya and Marc personas
- **Without mockup**: dispatch **user-advocate** to decide layout shape (page vs dialog, table vs cards) and produce a design brief
- If BLOCKER findings → revise before proceeding
- If only SUGGESTION findings → proceed with notes

### Step 2: Planning (feature-planner)
1. Dispatch **feature-planner** with the feature description + design brief from Step 1
2. Wait for plan approval before building

### Step 3: Implementation
1. Dispatch **frontend-builder** with the approved plan and design brief as constraints

### Step 4: Implementation Review
1. Dispatch **frontend-reviewer** + **user-advocate** in parallel
2. frontend-reviewer checks code quality, a11y, patterns
3. user-advocate checks final UX against both personas

## 5. Multi-Domain Features

For features spanning backend + frontend + infra:

1. **Backend first**: dispatch backend-builder (API, services, migrations)
2. **Frontend second**: dispatch frontend-builder (consumes the new API)
3. **Infra if needed**: dispatch devops-helper (CI, Docker, Helm changes)
4. **Review all**: dispatch relevant reviewers in parallel after all builders complete

## 6. Main Agent Role

The main agent (you) should:

- **Plan**: break down the task, identify agents needed
- **Delegate**: dispatch builders with clear, complete instructions
- **Integrate**: merge results, resolve conflicts between agent outputs
- **Coordinate reviews**: dispatch reviewers, triage findings
- **Report**: summarize what was done, what was found, what remains
