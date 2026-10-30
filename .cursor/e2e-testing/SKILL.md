---
name: e2e-testing
disable-model-invocation: true
description: >-
  Run, debug, and write Playwright E2E tests against the local Docker stack.
  Covers test execution (headless/UI/headed), auth switching, LLM-tagged tests,
  trace debugging, and page object conventions.
---

# E2E Testing with Playwright

Run Playwright E2E tests against the local Docker stack. Use when asked to run, debug, or write E2E tests.

## Prerequisites Check

Before running tests, verify the Docker stack is healthy:

```bash
# 1. Required services must be running
docker compose ps --format '{{.Service}} {{.State}}' | grep -E 'proxy|keycloak|backend|frontend|db'

# 2. If services are down, start them
docker compose up -d

# 3. Wait for Keycloak readiness (required for auth setup)
make _wait_keycloak DC='docker compose'
```

If `docker compose ps` shows no running services, the user needs to run `make setup` first (one-time), then `docker compose up -d`.

**Browsers must be installed locally (one-time):**

```bash
cd frontend && pnpm exec playwright install chromium
```

## Important: Host vs Docker

- **E2E tests run on the HOST machine**, not inside Docker containers
- Docker services must be running (tests connect to `https://app.llm.localhost` via Traefik)
- Browsers need to be installed locally, not in Docker

## Running E2E Tests

All commands run from the `frontend/` directory.

### Interactive UI mode

```bash
cd frontend && pnpm exec playwright test --ui
```

The UI allows you to:
- Select which tests to run
- Watch mode (re-run on file changes)
- Time travel debugging
- See browser side-by-side with code

### Headless execution

```bash
cd frontend && pnpm exec playwright test
cd frontend && pnpm exec playwright test tests/access_control.spec.ts
cd frontend && pnpm exec playwright test -g "test name pattern"
```

### Only UI tests (no LLM)

```bash
cd frontend && pnpm exec playwright test --project=chromium-ui
```

### Only LLM-tagged tests

```bash
cd frontend && pnpm exec playwright test --project=chromium-llm
```

## Test Configuration

Config file: `frontend/playwright.config.ts`

| Setting | Value |
|---------|-------|
| Base URL | `https://app.llm.localhost` (Traefik proxy) |
| Test dir | `frontend/tests/` (excludes `tests/unit/`) |
| Projects | `setup`, `chromium-ui`, `chromium-llm` |
| Workers | 1 per project |
| Retries | 2 on CI, 0 locally |
| Auth state | `frontend/playwright/.auth/{admin,user,limited}.json` |

## Writing E2E Tests

### File structure

- Spec files: `frontend/tests/<feature>.spec.ts`
- Page objects: `frontend/tests/pages/<page>.ts`
- Shared utilities: `frontend/tests/utils.ts`
- Auth setup: `frontend/tests/auth.setup.ts`

### Auth switching

```typescript
test.use({ storageState: 'playwright/.auth/user.json' });

test('regular user sees forbidden page', async ({ page }) => {
  await page.goto('/settings/users');
  await expect(page.getByText('Forbidden')).toBeVisible();
});
```

Available auth states: `admin` (full access), `user` (regular), `limited` (restricted permissions).

### Tagging LLM tests

Tests that require a live LLM endpoint must be tagged with `@llm` in the title:

```typescript
test('evaluation runs successfully @llm', async ({ page }) => {
  // This test only runs in the chromium-llm project
});
```

### Tips

- Modal dialogs must be dismissed (Escape key) before checking page updates
- Use `.first()` for duplicate elements (e.g. pagination sections)
- Import `waitForAppSettled`, `selectZephyrProject`, `createEvaluation`, `importDataset`, `waitForTableRows` from `frontend/tests/utils.ts`

## Debugging Failures

### View trace on retry

Traces are captured on first retry:

```bash
cd frontend && pnpm exec playwright show-trace test-results/<test-folder>/trace.zip
```

### Headed browser

```bash
cd frontend && pnpm exec playwright test --headed tests/access_control.spec.ts
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `ERR_CONNECTION_REFUSED` on `app.llm.localhost` | Docker stack not running | `docker compose up -d` |
| Browser not found | Playwright browsers not installed | `cd frontend && pnpm exec playwright install chromium` |
| Auth setup fails | Keycloak not ready | `make _wait_keycloak DC='docker compose'` |
| Tests fail on modal interactions | Modal not dismissed | Dismiss modals with Escape before assertions |
| `net::ERR_CERT_AUTHORITY_INVALID` | Self-signed TLS cert | Already handled: `ignoreHTTPSErrors: true` in config |
| Tests pass locally, fail in CI | Timing issues | Add `waitForAppSettled()`, increase timeouts |
