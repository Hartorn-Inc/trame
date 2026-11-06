/**
 * ============================================================================
 * TWO-BROWSER CAMPAIGN JOURNEY: GM + PLAYER (campaign.spec.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Drives one full D&D 5e session through the real UI with two simultaneous
 * browser contexts (GM and player), each recording video: Owner setup,
 * campaign invite and redemption, character creation (a level-1 Wizard),
 * map import and activation, doors, conditions and GM rulings, tokens,
 * initiative, movement and reactions, damage/heal/undo, SRD monsters spawned
 * from the compendium, sheet attacks and area spells resolved with an
 * explicit Apply, spell slots, dice, sheet conflict, documents and handouts,
 * and the player projection rules.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Assert Outcomes, Keep Going`:
 *    - Every phase runs in `phase()`: a failure is recorded as a soft failure
 *      with screenshots of both pages and the journey continues, so one
 *      report covers the whole flow. The test still fails if any phase did.
 * 2. `Projection Checked On The Wire`:
 *    - Player secrecy (monster HP/AC, GM-hidden tokens, secret doors, GM
 *      notes) is asserted on the decoded socket frames and REST payloads the
 *      player received, not only on what the UI rendered.
 * 3. `Production Hardening Observed From The Browser`:
 *    - Every `securitypolicyviolation` and CSP console message in either
 *      context fails the run, as do brand font faces that are not `loaded`
 *      or font decode errors; index.html must carry the app CSP while API
 *      responses keep the strict one.
 * 4. `Pixels, Not DOM, For The Renderer`:
 *    - Darkness, lights and fog are asserted on composited screenshots of
 *      the WebGL board (`support/pixels.ts` luminance probes), comparing GM
 *      and player and before/after states rather than absolute colours.
 * 5. `Synchronized Recordings`:
 *    - Both contexts are created and closed together, so `gm.webm` and
 *      `player.webm` share one timeline for the side-by-side video.
 * 6. `Invite-Only Accounts, No Backdoor`:
 *    - The GM claims the fresh instance as `Owner` through the real setup URL
 *      the server logged (`owner_bootstrap_url`), which `make e2e` passes in
 *      as `E2E_SETUP_URL`; the player's account is created by redeeming the
 *      `CampaignInvite` link. Both URLs are opened by path and query against
 *      `baseURL`, so they work whatever origin `TRAME_PUBLIC_ORIGIN` names.
 * 7. `Crash Recovery Across Two Runs, No Server Backdoor`:
 *    - The Playwright container shares the server container's network
 *      namespace, so the server cannot be killed under a running browser.
 *      The journey ends its table changes with damage + undo and writes
 *      `artifacts/crash-handoff.json`; `make e2e` then runs
 *      `docker kill -s KILL` on trame-server, restarts it, and runs this
 *      spec again with `E2E_STAGE=after-restart`, which signs both users
 *      back in and asserts the WAL-recovered table shows the undone HP.
 * 8. `GM-Side Resolution Against Monsters`:
 *    - A player never sees a monster's AC or save bonuses, and the room only
 *      lets a player apply damage to tokens they control, so the sheet attack
 *      and the area spell against the SRD monster are resolved and applied
 *      by the GM (who sees every number); the player checks the tier only.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * GM claims Owner -> campaign -> invite -> player redeems -> characters (both)
 * -> sheet edit + version conflict -> UVTT import + background + secret door
 * + locked door + GM light + hidden goblin -> activate -> tokens -> WebGL
 * renderer, fog, GM vision preview, night + lights (pixel probes) ->
 * projection checks -> door handles and vision -> Restrained + GM ruling ->
 * combat -> player reload (initiative after reconnect) -> movement /
 * opportunity attack -> damage, undo, heal -> compendium monster -> GM sheet
 * attack + Apply -> player slot spend -> GM area spell + save-for-half Apply
 * -> dice (WS + REST) -> documents + handout
 * -> player export refused -> offline / online reconnect -> damage + undo
 * before the crash -> fonts + CSP checks -> videos saved under `artifacts/`.
 * [harness: SIGKILL + restart] -> `E2E_STAGE=after-restart`: sign in again
 * -> GM and player see the undone HP (no ghost damage).
 * ============================================================================
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backgroundPng, uvttBundle } from '../support/fixtures.ts';
import { decodePng, meanLuma, type ProbeRect, type RgbaImage } from '../support/pixels.ts';
import { latestState, recordRoomFrames, states, type RecordedFrame } from '../support/wire.ts';

const ARTIFACTS = process.env.E2E_ARTIFACTS_DIR ?? 'artifacts';
const SCREENS = join(ARTIFACTS, 'screens');
const VIEWPORT = { width: 1280, height: 800 };
const RUN = Date.now().toString(36);
const PASSWORD = 'Crypt-Lantern-Quill-2026!';

const GM = { email: `gm-${RUN}@e2e.trame.test`, name: 'Game Master' };
const PLAYER = { email: `player-${RUN}@e2e.trame.test`, name: 'Player One' };
/** Owner setup URL from the server's `owner_bootstrap_url` log line (set by `make e2e`). */
const SETUP_URL = process.env.E2E_SETUP_URL ?? '';
const PC_NAME = 'Lyra Thornwood';
const MONSTER_NAME = 'Grak the Goblin Boss';
const CAMPAIGN = `Crypt of Embers ${RUN}`;
/** Pause after each phase so the recording can be followed by eye (ms). */
const PHASE_PAUSE_MS = 1000;
/** `after-restart` selects the post-SIGKILL check (invariant 7); unset runs the journey. */
const STAGE = process.env.E2E_STAGE ?? 'journey';
/** State the journey hands to the post-restart run (invariant 7). */
const CRASH_HANDOFF = join(ARTIFACTS, 'crash-handoff.json');

/** Contents of `CRASH_HANDOFF`. */
interface CrashHandoff {
  campaignId: string;
  pcTokenId: string;
  /** PC hit points after the undo, i.e. what the table must show after recovery. */
  pcHp: number;
  pcMaxHp: number;
  gmEmail: string;
  playerEmail: string;
}
/**
 * GM light placed in the map studio (board px, 10 ft = 140 px dim radius),
 * outside the UVTT torch's 420 px reach around (210, 210).
 */
const NEW_LIGHT = { x: 630, y: 70 };
/**
 * Board probes (px) on the 840x700 UVTT crypt, all above y = 540 because the
 * lower board rows sit below the visible table panel at 1280x800. `east` lies
 * behind the x=700 wall + closed door, out of the player's sight from the
 * top-left token; `west` is open floor in sight; `unlit` is outside both
 * lights' reach and above the secret door's shadow; `lit` surrounds the GM light.
 */
const PROBE: Record<'east' | 'west' | 'unlit' | 'lit', ProbeRect> = {
  east: { x: 715, y: 20, w: 115, h: 240 },
  west: { x: 280, y: 160, w: 140, h: 140 },
  unlit: { x: 635, y: 345, w: 55, h: 60 },
  lit: { x: NEW_LIGHT.x - 30, y: NEW_LIGHT.y - 30, w: 60, h: 60 },
};
/**
 * Floor east of the UVTT door (x = 700, y = 280..420) that the PC token in the
 * top-left column sees only through the open door.
 */
const PROBE_BEYOND_DOOR: ProbeRect = { x: 725, y: 335, w: 90, h: 60 };
/** Locked door the GM adds in the studio (board px), away from every probe. */
const LOCKED_DOOR = { p1: { x: 140, y: 560 }, p2: { x: 280, y: 560 } };
/** SRD monster spawned from the compendium; numbers from `packs/monsters.json`. */
const SRD_MONSTER = { slug: 'srd:monster:pirate_captain', name: 'Pirate Captain', hp: 84, ac: 17 };
/** Spells the player's Wizard writes into the spellbook at creation. */
const WIZARD_SPELLS = ['srd:spell:burning_hands', 'srd:spell:mage_armor'];

interface PhaseResult {
  phase: string;
  status: 'pass' | 'fail';
  note: string;
}

const results: PhaseResult[] = [];
const notes: string[] = [];
let shotIndex = 0;

/** Records an observation printed in the final summary (and the report). */
function note(text: string): void {
  notes.push(text);
  test.info().annotations.push({ type: 'note', description: text });
}

async function shot(pages: Record<string, Page>, label: string): Promise<void> {
  shotIndex += 1;
  const prefix = String(shotIndex).padStart(2, '0');
  for (const [who, page] of Object.entries(pages)) {
    await page.screenshot({ path: join(SCREENS, `${prefix}-${label}-${who}.png`) }).catch(() => undefined);
  }
}

async function newRecordedContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: VIEWPORT,
    locale: 'en-US',
    recordVideo: { dir: join('test-results', 'videos'), size: VIEWPORT },
  });
}

/** Last path segment of a `data-testid` with the given prefix, e.g. `actor-<uuid>`. */
async function idFromTestId(locator: Locator, prefix: string): Promise<string> {
  const testId = await locator.getAttribute('data-testid');
  if (!testId?.startsWith(prefix)) throw new Error(`unexpected test id ${testId}`);
  return testId.slice(prefix.length);
}

/** Path and query of an absolute URL, so it is opened against `baseURL`. */
function pathAndQuery(url: string): string {
  const { pathname, search } = new URL(url);
  return `${pathname}${search}`;
}

function hpOf(text: string): { hp: number; max: number } {
  const m = /HP (\d+) \/ (\d+)/.exec(text);
  if (!m) throw new Error(`no HP in "${text}"`);
  return { hp: Number(m[1]), max: Number(m[2]) };
}

/** Returns a phase runner: failures become soft failures with screenshots of `pages` (invariant 1). */
function phaseRunner(pages: Record<string, Page>, pauseMs: number) {
  return async (name: string, fn: () => Promise<string | void>) => {
    await test.step(name, async () => {
      try {
        const detail = (await fn()) ?? '';
        results.push({ phase: name, status: 'pass', note: detail });
        await Object.values(pages)[0].waitForTimeout(pauseMs);
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '');
        results.push({ phase: name, status: 'fail', note: message });
        await shot(pages, `FAIL-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
        expect.soft(message, `phase "${name}" failed`).toBe('');
      }
    });
  };
}

function printPhases(): void {
  console.log(results.map((r) => `${r.status.toUpperCase().padEnd(4)} ${r.phase}${r.note ? ` — ${r.note}` : ''}`).join('\n'));
}

/** Signs in through the sign-in screen and opens the campaign's live table. */
async function signInToTable(page: Page, email: string, campaignId: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('auth-screen')).toBeVisible();
  await page.getByTestId('auth-email').fill(email);
  await page.getByTestId('auth-password').fill(PASSWORD);
  await page.getByTestId('auth-submit').click();
  const open = page.getByTestId(`lobby-open-${campaignId}`);
  await expect(page.getByTestId('campaign-workspace').or(open)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(page.getByTestId('campaign-workspace')).toBeVisible();
  await page.getByTestId('workspace-tab-table').click();
  await expect(page.getByTestId('table-map')).toBeVisible();
}

test('GM and player play one campaign session end to end', async ({ browser }) => {
  test.skip(STAGE === 'after-restart', 'the journey runs before the harness kills the server');
  test.setTimeout(20 * 60_000);
  mkdirSync(SCREENS, { recursive: true });

  const gmCtx = await newRecordedContext(browser);
  const plCtx = await newRecordedContext(browser);
  const gm = await gmCtx.newPage();
  const pl = await plCtx.newPage();
  const both = { gm, player: pl };
  const gmFrames = recordRoomFrames(gm);
  const plFrames = recordRoomFrames(pl);
  const consoleLog: string[] = [];
  const cspViolations: string[] = [];
  const fontErrors: string[] = [];
  for (const ctx of [gmCtx, plCtx]) {
    await ctx.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        console.error(`[e2e-csp] ${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile}:${e.lineNumber}`);
      });
    });
  }
  for (const [who, page] of Object.entries(both)) {
    page.on('pageerror', (err) => consoleLog.push(`[${who}] pageerror ${err.message}`));
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error' || msg.type() === 'warning') consoleLog.push(`[${who}] ${msg.type()} ${text}`);
      if (/\[e2e-csp\]|Content Security Policy|Refused to (load|execute|apply|connect|compile)/.test(text)) cspViolations.push(`[${who}] ${text}`);
      if (/OTS parsing error|Failed to decode downloaded font/.test(text)) fontErrors.push(`[${who}] ${text}`);
    });
    page.on('response', async (res) => {
      if (!res.url().includes('/api/') || res.status() < 400) return;
      const body = res.status() >= 500 ? ` ${(await res.text().catch(() => '')).slice(0, 300)}` : '';
      consoleLog.push(`[${who}] HTTP ${res.status()} ${res.request().method()} ${res.url()}${body}`);
    });
  }

  const phase = phaseRunner(both, PHASE_PAUSE_MS);

  let campaignId = '';
  let pcActorId = '';
  let monsterActorId = '';
  let pcTokenId = '';
  let monsterTokenId = '';
  let hiddenTokenId = '';
  const campaignApi = (path: string) => `/api/v1/campaigns/${campaignId}${path}`;
  const openTab = async (page: Page, tab: string) => {
    await page.getByTestId(`workspace-tab-${tab}`).click();
    await expect(page.getByTestId(`workspace-panel-${tab}`)).toBeVisible();
  };
  const closeSheet = async (page: Page) => {
    const close = page.getByTestId('btn-close-sheet-drawer');
    if (await close.isVisible()) await close.click();
  };

  await pl.setContent('<main style="font:24px sans-serif;display:grid;place-items:center;height:100vh">Player: waiting for the invite link…</main>');

  await phase('Server health', async () => {
    await expect
      .poll(async () => (await gm.request.get('/healthz').catch(() => null))?.status() ?? 0, { timeout: 60_000 })
      .toBe(200);
    const root = await gm.request.get('/');
    expect(root.status()).toBe(200);
    const html = await root.text();
    expect(html).toContain('<div id="app"');
    const appCsp = root.headers()['content-security-policy'] ?? '';
    expect(appCsp, 'index.html carries the app CSP').toContain("script-src 'self'");
    const bundle = /\/assets\/[^"]+\.js/.exec(html)?.[0];
    expect(bundle, 'index.html references a hashed bundle').toBeTruthy();
    const js = await gm.request.get(bundle!);
    expect(js.status()).toBe(200);
    expect(js.headers()['content-type']).toMatch(/javascript/);
    const api = await gm.request.get('/api/v1/auth/me');
    expect(api.status()).toBe(401);
    const apiCsp = api.headers()['content-security-policy'] ?? '';
    expect(apiCsp, 'API responses keep the strict CSP').toContain("default-src 'none'");
    expect(apiCsp).not.toContain('script-src');
    return `bundle ${bundle} served by trame-server; app CSP: ${appCsp}`;
  });

  await phase('GM claims the instance as Owner through the logged setup URL', async () => {
    expect(SETUP_URL, 'E2E_SETUP_URL from the owner_bootstrap_url log line').toMatch(/\/setup\?token=/);
    await gm.goto(pathAndQuery(SETUP_URL));
    await expect(gm.getByTestId('owner-setup-screen')).toBeVisible();
    await expect(gm).not.toHaveURL(/token=/);
    await expect(gm.getByTestId('setup-form')).toBeVisible();
    await gm.getByTestId('setup-email').fill(GM.email);
    await gm.getByTestId('setup-display-name').fill(GM.name);
    await gm.getByTestId('setup-password').fill(PASSWORD);
    await shot({ gm }, 'gm-owner-setup');
    await gm.getByTestId('setup-submit').click();
    await expect(gm.getByTestId('campaign-lobby')).toBeVisible();
    const me = await (await gm.request.get('/api/v1/auth/me')).text();
    expect(me, 'the GM session carries the Owner instance role').toMatch(/"instance_role":"OWNER"/);
    return 'GM signed in as instance Owner';
  });

  await phase('GM creates a campaign', async () => {
    await gm.getByTestId('lobby-campaign-name').fill(CAMPAIGN);
    await gm.getByTestId('lobby-create').click();
    const row = gm.locator('li[data-testid^="lobby-campaign-"]', { hasText: CAMPAIGN });
    await expect(row).toBeVisible();
    campaignId = await idFromTestId(row, 'lobby-campaign-');
    return `campaign ${campaignId}`;
  });

  let inviteUrl = '';
  await phase('GM mints a campaign invite link', async () => {
    await gm.getByTestId(`lobby-invite-${campaignId}`).click();
    await expect(gm.getByTestId('invite-dialog')).toBeVisible();
    await expect(gm.getByTestId('invite-none')).toBeVisible();
    await gm.getByTestId('invite-create').click();
    const field = gm.getByTestId('invite-url');
    await expect(field).toHaveValue(/invite=/);
    inviteUrl = await field.inputValue();
    await expect(gm.getByTestId('invite-status')).toBeVisible();
    await shot({ gm }, 'gm-invite');
    await gm.getByTestId('invite-dialog-close').click();
    await expect(gm.getByTestId('invite-dialog')).toBeHidden();
    return inviteUrl.replace(/invite=.*/, 'invite=<token>');
  });

  await phase('Player creates an account from the invite link and lands in the campaign', async () => {
    await pl.goto(pathAndQuery(inviteUrl));
    await expect(pl.getByTestId('invite-redemption-screen')).toBeVisible();
    await expect(pl).not.toHaveURL(/invite=/);
    await expect(pl.getByTestId('invite-campaign')).toContainText(CAMPAIGN);
    await expect(pl.getByTestId('invite-mode-create')).toHaveAttribute('aria-pressed', 'true');
    await pl.getByTestId('invite-display-name').fill(PLAYER.name);
    await pl.getByTestId('invite-email').fill(PLAYER.email);
    await pl.getByTestId('invite-password').fill(PASSWORD);
    await shot({ player: pl }, 'player-invite');
    await pl.getByTestId('invite-submit').click();
    await expect(pl.getByTestId('campaign-workspace')).toBeVisible();
    await expect(pl.getByTestId('trame-status-badge')).toBeVisible();
    await gm.getByTestId(`lobby-invite-${campaignId}`).click();
    await expect(gm.getByTestId('redemptions-list')).toContainText(PLAYER.name);
    await gm.getByTestId('invite-dialog-close').click();
    await gm.getByTestId(`lobby-open-${campaignId}`).click();
    await expect(gm.getByTestId('campaign-workspace')).toBeVisible();
    await shot(both, 'joined');
  });

  /**
   * Fills the class choices of the current builder step: the first option of
   * every single-pick radio group, then free checkboxes until each multi-pick
   * is full (the modal disables the rest once `count` are chosen).
   */
  const fillClassChoices = async (page: Page) => {
    const modal = page.getByTestId('character-builder-modal');
    const groups = await modal.locator('input[type="radio"][name^="class-"]').evaluateAll((els) => [...new Set(els.map((el) => (el as HTMLInputElement).name))]);
    for (const group of groups) await modal.locator(`input[type="radio"][name="${group}"]`).first().check();
    const free = modal.locator('input[type="checkbox"]:not(:checked):not(:disabled)');
    for (let i = 0; i < 30 && (await free.count()) > 0; i++) await free.first().check();
  };

  /**
   * Walks the eight-step creation modal (2024 origins, class skills,
   * equipment and spells) and returns the new actor id. `scores` reassigns the
   * standard array; `spells` are picked before the remaining spell slots fill.
   */
  const createCharacter = async (
    page: Page,
    name: string,
    classId: string,
    options: { scores?: Record<string, number>; spells?: string[] } = {},
  ) => {
    await openTab(page, 'actors');
    await page.getByTestId('actors-new').click();
    const modal = page.getByTestId('character-builder-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('builder-step-species')).toBeVisible();
    await page.locator('input[name="species"]').first().check();
    await page.getByTestId('builder-next').click();
    await expect(page.getByTestId('builder-step-class')).toBeVisible();
    const cls = page.getByTestId(`builder-class-${classId}`);
    await ((await cls.count()) > 0 ? cls : page.locator('input[name="class"]').first()).check();
    await page.getByTestId('builder-next').click();
    await expect(page.getByTestId('builder-step-background')).toBeVisible();
    await page.locator('input[name="background"]').first().check();
    await page.getByTestId('builder-split-plus1_each').check();
    await page.getByTestId('builder-next').click();
    await expect(page.getByTestId('builder-step-abilityScores')).toBeVisible();
    await page.getByTestId('builder-method-standardArray').check();
    for (const [ability, score] of Object.entries(options.scores ?? {})) {
      await page.getByTestId(`builder-score-${ability}`).selectOption(String(score));
    }
    await page.getByTestId('builder-next').click();
    await expect(page.getByTestId('builder-step-skills')).toBeVisible();
    await fillClassChoices(page);
    await page.getByTestId('builder-next').click();
    await expect(page.getByTestId('builder-step-equipment')).toBeVisible();
    await fillClassChoices(page);
    await page.getByTestId('builder-equipment-package').check();
    await page.getByTestId('builder-next').click();
    await expect(page.getByTestId('builder-step-spells')).toBeVisible();
    for (const spell of options.spells ?? []) await page.getByTestId(`builder-spells-${spell}`).check();
    await fillClassChoices(page);
    await page.getByTestId('builder-next').click();
    await expect(page.getByTestId('builder-step-review')).toBeVisible();
    await page.getByTestId('builder-name').fill(name);
    const summary = (await page.getByTestId('builder-summary').innerText()).replace(/\s+/g, ' ');
    await shot({ [name.split(' ')[0].toLowerCase()]: page }, 'builder-review');
    const created = page.waitForResponse((r) => r.url().endsWith('/actors') && r.request().method() === 'POST');
    await page.getByTestId('builder-create').click();
    expect((await created).status()).toBe(201);
    await expect(modal).toBeHidden();
    const row = page.locator('li[data-testid^="actor-"]', { hasText: name });
    await expect(row).toBeVisible();
    return { id: await idFromTestId(row, 'actor-'), summary };
  };

  await phase('Player creates a level-1 Wizard (species, class, background, skills, equipment, spells)', async () => {
    const pc = await createCharacter(pl, PC_NAME, 'wizard', {
      scores: { str: 12, int: 15, dex: 13, con: 14 },
      spells: WIZARD_SPELLS,
    });
    pcActorId = pc.id;
    await expect(pl.getByTestId('hud-sheet-drawer')).toBeVisible();
    await expect(pl.getByTestId('sheet-actor-name')).toHaveText(PC_NAME);
    await shot({ player: pl }, 'player-sheet');
    return pc.summary;
  });

  await phase('GM creates an NPC monster through the same modal', async () => {
    const monster = await createCharacter(gm, MONSTER_NAME, 'barbarian');
    monsterActorId = monster.id;
    await closeSheet(gm);
    return monster.summary;
  });

  const bio = async (page: Page) => {
    const area = page.getByTestId('bio-textarea');
    if (!(await area.isVisible())) {
      const tabs = page.locator('[data-testid^="tab-btn-"]');
      for (let i = 0; i < (await tabs.count()) && !(await area.isVisible()); i++) await tabs.nth(i).click();
    }
    return area;
  };

  await phase('Player edits and saves the sheet', async () => {
    const area = await bio(pl);
    const saved = pl.waitForResponse((r) => r.url().includes(`/actors/${pcActorId}`) && r.request().method() === 'PUT');
    await area.fill('Raised by the lamplighters of Emberfall.');
    await area.blur();
    expect((await saved).status()).toBe(200);
    const stored = await (await pl.request.get(campaignApi(`/actors/${pcActorId}`))).json();
    expect(JSON.stringify(stored)).toContain('lamplighters');
  });

  await phase('Version conflict: stale player save, then overwrite', async () => {
    await openTab(gm, 'maps');
    await openTab(gm, 'actors');
    await gm.getByTestId(`actor-open-${pcActorId}`).click();
    await expect(gm.getByTestId('sheet-actor-name')).toHaveText(PC_NAME);
    const area = await bio(gm);
    const gmSaved = gm.waitForResponse((r) => r.url().includes(`/actors/${pcActorId}`) && r.request().method() === 'PUT');
    await area.fill('Raised by the lamplighters of Emberfall. (GM: owes the guild a debt.)');
    await area.blur();
    expect((await gmSaved).status()).toBe(200);
    await closeSheet(gm);

    await pl.getByTestId('btn-long-rest').click();
    const rest = pl.getByTestId('rest-modal');
    await expect(rest).toBeVisible();
    const stale = pl.waitForResponse((r) => r.url().includes(`/actors/${pcActorId}`) && r.request().method() === 'PUT');
    await rest.locator('.ds-modal-footer .ds-btn-primary').click();
    expect((await stale).status()).toBe(409);
    await expect(pl.getByTestId('sheet-version-conflict')).toBeVisible();
    await shot(both, 'sheet-conflict');
    const overwrite = pl.waitForResponse((r) => r.url().includes(`/actors/${pcActorId}`) && r.request().method() === 'PUT');
    await pl.getByTestId('btn-conflict-overwrite').click();
    expect((await overwrite).status()).toBe(200);
    await expect(pl.getByTestId('sheet-version-conflict')).toBeHidden();
    await closeSheet(pl);
  });

  await phase('GM imports a UVTT map and uploads a background', async () => {
    await openTab(gm, 'maps');
    await expect(gm.getByTestId('maps-workspace')).toBeVisible();
    const imported = gm.waitForResponse((r) => r.url().includes('/maps/import'));
    await gm.getByTestId('maps-import-uvtt').setInputFiles({ name: 'ember-crypt.uvtt', mimeType: 'application/json', buffer: uvttBundle() });
    expect((await imported).status()).toBeLessThan(300);
    await expect(gm.locator('[data-testid^="scene-item-"]')).toHaveCount(1);
    await expect(gm.getByTestId('maps-error')).toBeHidden();
    await gm.getByTestId('maps-background-scene').selectOption({ index: 1 });
    const uploaded = gm.waitForResponse((r) => r.url().endsWith('/assets') && r.request().method() === 'POST');
    await gm.getByTestId('maps-upload-background').setInputFiles({ name: 'ember-floor.png', mimeType: 'image/png', buffer: backgroundPng() });
    expect((await uploaded).status()).toBeLessThan(300);
    await expect(gm.getByTestId('maps-status')).not.toBeEmpty();
    await expect(gm.getByTestId('maps-error')).toBeHidden();
    return (await gm.getByTestId('maps-status').innerText()).trim();
  });

  await phase('GM adds a secret door, a locked door and a hidden goblin, reveals, saves, activates', async () => {
    await gm.locator('[data-testid^="scene-item-"]').first().click();
    const addWall = async (type: string, p1: { x: number; y: number }, p2: { x: number; y: number }) => {
      await gm.getByTestId('wall-type-select').selectOption(type);
      await gm.getByTestId('wall-p1x-input').fill(String(p1.x));
      await gm.getByTestId('wall-p1y-input').fill(String(p1.y));
      await gm.getByTestId('wall-p2x-input').fill(String(p2.x));
      await gm.getByTestId('wall-p2y-input').fill(String(p2.y));
      await gm.getByTestId('add-wall-btn').click();
    };
    await addWall('SecretDoor', { x: 420, y: 420 }, { x: 560, y: 420 });
    const locks = gm.locator('[data-testid^="toggle-lock-"]');
    const doorsBefore = await locks.count();
    await addWall('Door', LOCKED_DOOR.p1, LOCKED_DOOR.p2);
    await expect(locks).toHaveCount(doorsBefore + 1);
    const lockId = await idFromTestId(locks.last(), 'toggle-lock-');
    await locks.last().click();
    await expect(gm.getByTestId(`lock-badge-${lockId}`)).toBeVisible();
    await gm.getByTestId('light-x-input').fill(String(NEW_LIGHT.x));
    await gm.getByTestId('light-y-input').fill(String(NEW_LIGHT.y));
    await gm.getByTestId('light-radius-input').fill('10');
    await gm.getByTestId('add-light-btn').click();
    await gm.getByTestId('template-Goblin').click();
    const reveal = gm.getByTestId('toggle-revealed-btn');
    if ((await reveal.getAttribute('aria-pressed')) !== 'true') await reveal.click();
    await expect(reveal).toHaveAttribute('aria-pressed', 'true');
    const saved = gm.waitForResponse((r) => r.url().endsWith('/maps') && r.request().method() === 'PUT');
    await gm.getByTestId('save-scene-btn').click();
    expect((await saved).status()).toBeLessThan(300);
    await shot({ gm }, 'gm-maps-studio');
    const activated = gm.waitForResponse((r) => r.url().endsWith('/maps') && r.request().method() === 'PUT');
    await gm.getByTestId('activate-scene-btn').click();
    expect((await activated).status()).toBeLessThan(300);
    await expect(gm.getByTestId('maps-error')).toBeHidden();
    await expect.poll(() => latestState(gmFrames)?.map_width_px ?? 0).toBeGreaterThan(0);
    await expect.poll(() => latestState(gmFrames)?.walls.length ?? 0).toBeGreaterThan(0);
    const gmWalls = latestState(gmFrames)?.walls ?? [];
    const lights = (latestState(gmFrames)?.lights ?? []) as Array<Record<string, unknown>>;
    expect(lights.length, 'UVTT torch + GM light').toBe(2);
    expect(gmWalls.some((w) => (w.kind as Record<string, unknown> | undefined)?.is_locked === true), 'the locked door reached the table').toBe(true);
    return `GM table has ${gmWalls.length} walls and ${lights.length} lights (color_hex ${lights.map((l) => l.color_hex).join(', ')})`;
  });

  await phase('Both clients see the activated scene with its background', async () => {
    await openTab(gm, 'table');
    await openTab(pl, 'table');
    await expect(gm.getByTestId('table-map')).toBeVisible();
    await expect(pl.getByTestId('table-map')).toBeVisible();
    const goblin = gm.locator('button[data-testid^="token-"][aria-label^="Goblin"]');
    await expect(goblin).toHaveCount(1);
    hiddenTokenId = await idFromTestId(goblin, 'token-');
    await shot(both, 'scene-active');
  });

  await phase('GM places the player character and the monster', async () => {
    await openTab(gm, 'actors');
    await gm.getByTestId(`actor-place-${pcActorId}`).click();
    await expect.poll(() => Object.values(latestState(gmFrames)?.tokens ?? {}).some((t) => t.actor_id === pcActorId)).toBe(true);
    await gm.getByTestId(`actor-place-${monsterActorId}`).click();
    await expect.poll(() => Object.values(latestState(gmFrames)?.tokens ?? {}).some((t) => t.actor_id === monsterActorId)).toBe(true);
    const tokens = Object.values(latestState(gmFrames)?.tokens ?? {});
    pcTokenId = String(tokens.find((t) => t.actor_id === pcActorId)?.id);
    monsterTokenId = String(tokens.find((t) => t.actor_id === monsterActorId)?.id);
    await openTab(gm, 'table');
    await expect(gm.getByTestId(`token-${pcTokenId}`)).toBeVisible();
    await expect(gm.getByTestId(`token-${monsterTokenId}`)).toBeVisible();
    await expect(pl.getByTestId(`token-${pcTokenId}`)).toBeVisible();
    await expect(pl.getByTestId(`token-${monsterTokenId}`)).toBeVisible();
    await shot(both, 'tokens-placed');
  });

  /** Composited pixels of the live board after the renderer drew the latest state. */
  const board = async (page: Page): Promise<RgbaImage> => {
    await page.waitForTimeout(700);
    return decodePng(await page.getByTestId('table-board').screenshot());
  };
  const lumas = (img: RgbaImage) =>
    Object.fromEntries(Object.entries(PROBE).map(([k, r]) => [k, meanLuma(img, r)])) as Record<keyof typeof PROBE, number>;
  const gmPreview = gm.getByTestId('table-preview-player-view');

  await phase('Live table renders through WebGL (PixiJS) in both browsers', async () => {
    const infos: string[] = [];
    for (const [who, page] of Object.entries(both)) {
      await expect(page.getByTestId('table-board'), `${who}: PixiJS board`).toHaveClass(/is-pixi/);
      await expect(page.getByTestId('table-map'), `${who}: battlemap drawn on the canvas`).toHaveJSProperty('tagName', 'CANVAS');
      const gl = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas.trame-pixijs-canvas');
        const ctx = (canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')) as WebGLRenderingContext | null;
        const dbg = ctx?.getExtension('WEBGL_debug_renderer_info');
        return {
          version: ctx ? String(ctx.getParameter(ctx.VERSION)) : null,
          renderer: ctx ? String(dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER)) : null,
        };
      });
      expect(gl.version, `${who}: WebGL context on the table canvas`).toMatch(/WebGL/);
      infos.push(`${who}: ${gl.version} / ${gl.renderer}`);
    }
    return infos.join(' | ');
  });

  await phase('Fog of war: player sees fog behind the east wall, GM sees the whole map', async () => {
    const g = lumas(await board(gm));
    const p = lumas(await board(pl));
    await shot(both, 'fog-gm-full-vs-player-fog');
    expect(Math.abs(g.east - g.west), 'GM: east crypt as bright as open floor').toBeLessThan(25);
    expect(p.east, 'player: east crypt fogged').toBeLessThan(p.west - 50);
    expect(p.east, 'player: fog darker than the GM view').toBeLessThan(g.east - 50);
    return `luma east/west GM ${g.east}/${g.west}, player ${p.east}/${p.west}`;
  });

  await phase('GM "Preview player vision" applies the players\' fog, then turns off', async () => {
    const before = lumas(await board(gm));
    await gmPreview.click();
    await expect(gmPreview).toHaveAttribute('aria-pressed', 'true');
    const preview = lumas(await board(gm));
    await shot({ gm }, 'gm-preview-player-vision');
    expect(preview.east, 'preview dims the east crypt').toBeLessThan(before.east - 15);
    expect(Math.abs(preview.west - before.west), 'preview keeps the player-visible floor').toBeLessThan(15);
    await gmPreview.click();
    await expect(gmPreview).toHaveAttribute('aria-pressed', 'false');
    const after = lumas(await board(gm));
    expect(Math.abs(after.east - before.east), 'preview off restores the full map').toBeLessThan(10);
    return `GM east luma ${before.east} -> preview ${preview.east} -> off ${after.east}`;
  });

  await phase('GM sets night darkness; both views darken and show the GM light', async () => {
    const gBefore = lumas(await board(gm));
    const pBefore = lumas(await board(pl));
    await gm.getByTestId('gm-lighting').selectOption('NIGHT_MOONLIGHT');
    await expect.poll(() => latestState(plFrames)?.ambient_lighting).toBe('NIGHT_MOONLIGHT');
    const g = lumas(await board(gm));
    const p = lumas(await board(pl));
    await shot(both, 'night-lights-gm-vs-player');
    for (const [who, before, now] of [['GM', gBefore, g], ['player', pBefore, p]] as const) {
      const values = `before ${JSON.stringify(before)} after ${JSON.stringify(now)}`;
      expect(now.unlit, `${who}: unlit floor darkens (${values})`).toBeLessThan(before.unlit - 30);
      expect(now.lit, `${who}: GM light brightens its area (${values})`).toBeGreaterThan(now.unlit + 25);
    }
    return `unlit luma GM ${gBefore.unlit}->${g.unlit}, player ${pBefore.unlit}->${p.unlit}; lit GM ${g.lit}, player ${p.lit}`;
  });

  await phase('Player projection: monster shows a health tier, never HP/AC', async () => {
    const label = await pl.getByTestId(`token-${monsterTokenId}`).getAttribute('aria-label');
    expect(label).toMatch(/Unhurt|Bloodied|Down/);
    expect(label).not.toMatch(/hit points/);
    for (const s of states(plFrames)) {
      expect(s.tokens[monsterTokenId], 'monster must not be a controlled token for the player').toBeUndefined();
      const pub = s.public_tokens?.[monsterTokenId];
      if (pub) {
        for (const secret of ['hp', 'max_hp', 'temp_hp', 'ac']) expect(Object.keys(pub)).not.toContain(secret);
      }
    }
    expect(plFrames.some((f) => f.tag === 'ActorUpdated' && f.payload.actor_id === monsterActorId)).toBe(false);
    const actors = await (await pl.request.get(campaignApi('/actors'))).json();
    expect(JSON.stringify(actors)).not.toContain(monsterActorId);
    const own = latestState(plFrames)?.tokens[pcTokenId];
    expect(typeof own?.hp).toBe('number');
    return label ?? '';
  });

  await phase('Player projection: GM-hidden token and secret door are withheld', async () => {
    expect(hiddenTokenId).not.toBe('');
    expect(JSON.stringify(plFrames)).not.toContain(hiddenTokenId);
    await expect(pl.getByTestId(`token-${hiddenTokenId}`)).toHaveCount(0);
    const gmKinds = (latestState(gmFrames)?.walls ?? []).map((w) => JSON.stringify(w));
    expect(gmKinds.some((w) => /secret/i.test(w)), 'GM state carries the secret door').toBe(true);
    expect(JSON.stringify(states(plFrames).map((s) => s.walls))).not.toMatch(/secret/i);
    const maps = await (await pl.request.get(campaignApi('/maps'))).text();
    expect(maps).not.toMatch(/secret/i);
    expect(maps).not.toContain('"Goblin"');
    await openTab(pl, 'maps');
    await expect(pl.getByTestId('scene-atlas')).toBeVisible();
    await shot({ player: pl }, 'player-atlas');
    await openTab(pl, 'table');
  });

  /** Door kind of a projected wall (`DOOR` / `SECRET_DOOR` carry `is_open`, doors `is_locked`). */
  type WireDoorKind = { kind?: string; is_open?: boolean; is_locked?: boolean };
  const wallsOf = (frames: RecordedFrame[]) => (latestState(frames)?.walls ?? []) as Array<{ id: string; kind?: WireDoorKind }>;

  await phase('Doors: GM opens the crypt door from its canvas handle; player vision reaches through; locked and secret doors stay shut', async () => {
    const walls = wallsOf(gmFrames);
    const crypt = walls.find((w) => w.kind?.kind === 'DOOR' && !w.kind.is_locked);
    const locked = walls.find((w) => w.kind?.kind === 'DOOR' && w.kind.is_locked);
    const secret = walls.find((w) => w.kind?.kind === 'SECRET_DOOR');
    if (!crypt || !locked || !secret) throw new Error(`missing doors on the GM table: ${JSON.stringify(walls.map((w) => w.kind))}`);
    const playerSeesOpen = () => wallsOf(plFrames).find((w) => w.id === crypt.id)?.kind?.is_open;
    expect(playerSeesOpen(), 'the crypt door starts closed for the player').toBe(false);
    const before = meanLuma(await board(pl), PROBE_BEYOND_DOOR);
    const handle = gm.getByTestId(`door-${crypt.id}`);
    await expect(handle).toHaveAttribute('aria-pressed', 'false');
    await handle.click();
    await expect(handle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(playerSeesOpen).toBe(true);
    await expect(pl.getByTestId(`door-${crypt.id}`)).toHaveAttribute('aria-pressed', 'true');
    const after = meanLuma(await board(pl), PROBE_BEYOND_DOOR);
    await shot(both, 'door-open-player-vision');
    expect(after, `player sees the floor beyond the open door (luma ${before} -> ${after})`).toBeGreaterThan(before + 15);
    const lockedForPlayer = pl.getByTestId(`door-${locked.id}`);
    await expect(lockedForPlayer).toBeDisabled();
    await expect(lockedForPlayer).toHaveAttribute('aria-label', /locked/);
    await expect(gm.getByTestId(`door-${secret.id}`), 'the GM can still work the secret door').toBeEnabled();
    await expect(pl.getByTestId(`door-${secret.id}`), 'the player gets no handle for the secret door').toHaveCount(0);
    await handle.click();
    await expect.poll(playerSeesOpen).toBe(false);
    return `player luma beyond the door ${before} -> ${after}; locked handle disabled; secret door absent for the player`;
  });

  await phase("Restrained sets Speed 0: the player's move is refused until the GM removes the effect", async () => {
    await gm.getByTestId(`token-${pcTokenId}`).click();
    await expect(gm.getByTestId('conditions-panel')).toBeVisible();
    const restrained = gm.getByTestId('condition-restrained');
    await restrained.click();
    await expect(restrained).toHaveAttribute('aria-pressed', 'true');
    await expect(gm.getByTestId('conditions-effects')).toContainText('Speed 0');
    await expect.poll(() => JSON.stringify(latestState(plFrames)?.tokens[pcTokenId]?.conditions ?? []).toLowerCase()).toContain('restrained');
    const token = pl.getByTestId(`token-${pcTokenId}`);
    await token.click();
    const start = await token.getAttribute('style');
    await token.press('ArrowDown');
    const refusal = pl.getByTestId('command-feedback-item').filter({ hasText: /Speed is 0/i });
    await expect(refusal.first()).toBeVisible();
    expect(await token.getAttribute('style'), 'the refused move left the token in place').toBe(start);
    const toast = (await refusal.first().innerText()).replace(/\s+/g, ' ').trim();
    await shot(both, 'speed-zero-refused');
    await gm.getByTestId('conditions-rulings').locator('summary').click();
    const ruling = gm.getByTestId('ruling-effect-restrained.speed_zero');
    await ruling.selectOption('REMOVE');
    await expect(gm.getByTestId('conditions-effects')).not.toContainText('Speed 0');
    await expect.poll(() => JSON.stringify(latestState(plFrames)?.tokens[pcTokenId]?.condition_overrides ?? [])).toContain('REMOVE');
    await token.press('ArrowDown');
    await expect.poll(() => token.getAttribute('style')).not.toBe(start);
    await shot(both, 'speed-zero-overridden');
    await token.press('ArrowUp');
    await expect.poll(() => token.getAttribute('style')).toBe(start);
    await ruling.selectOption('');
    await restrained.click();
    await expect(restrained).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => JSON.stringify(latestState(plFrames)?.tokens[pcTokenId]?.conditions ?? []).toLowerCase()).not.toContain('restrained');
    return `refusal toast: "${toast}"; after the GM REMOVE ruling the move succeeded`;
  });

  await phase('Combat tracker: start, set initiative, advance to the PC', async () => {
    await gm.getByTestId('combat-start').click();
    await expect(gm.getByTestId('combat-round')).toBeVisible();
    await expect(pl.getByTestId('combat-tracker')).toBeVisible();
    for (const [id, total] of [
      [pcTokenId, '25'],
      [monsterTokenId, '2'],
    ] as const) {
      const input = gm.getByTestId(`initiative-total-${id}`);
      await input.fill(total);
      await input.blur();
      await expect(input).toHaveValue(total);
    }
    for (let i = 0; i < 4 && !(await gm.getByTestId('combat-active').innerText()).includes(PC_NAME); i++) {
      await gm.getByTestId('combat-next').click();
      await gm.waitForTimeout(400);
    }
    await expect(gm.getByTestId('combat-active')).toContainText(PC_NAME);
    await expect(pl.getByTestId('combat-active')).toContainText(PC_NAME);
    await expect(pl.getByTestId(`initiative-value-${pcTokenId}`), 'player sees the GM-set initiative total live').toHaveText('25');
    await expect(pl.getByTestId(`initiative-value-${monsterTokenId}`)).toHaveText('2');
    await shot(both, 'combat-pc-turn');
    return (await gm.getByTestId('combat-round').innerText()).trim();
  });

  await phase('Player reloads mid-combat; initiative totals survive the reconnect', async () => {
    await pl.reload();
    const open = pl.getByTestId(`lobby-open-${campaignId}`);
    await expect(pl.getByTestId('campaign-workspace').or(open)).toBeVisible();
    if (await open.isVisible()) await open.click();
    await expect(pl.getByTestId('campaign-workspace')).toBeVisible();
    await openTab(pl, 'table');
    await expect(pl.getByTestId('combat-active')).toContainText(PC_NAME);
    await expect(pl.getByTestId(`initiative-value-${pcTokenId}`), 'GM-set total after reconnect').toHaveText('25');
    await expect(pl.getByTestId(`initiative-value-${monsterTokenId}`)).toHaveText('2');
    await shot({ player: pl }, 'player-reloaded-combat');
  });

  await phase('Player moves away from the monster; opportunity attack prompt', async () => {
    const token = pl.getByTestId(`token-${pcTokenId}`);
    const before = await token.getAttribute('style');
    await token.click();
    await token.press('ArrowDown');
    await expect.poll(() => token.getAttribute('style')).not.toBe(before);
    await token.press('ArrowDown');
    const prompt = gm.locator('[data-testid^="reaction-trigger-"]');
    const appeared = await prompt
      .first()
      .waitFor({ timeout: 6_000 })
      .then(() => true)
      .catch(() => false);
    const rejection = (await pl.getByTestId('command-feedback-item').allInnerTexts()).join(' | ').trim();
    await shot(both, 'movement');
    if (!appeared) {
      note(`No opportunity-attack prompt after leaving reach (player rejection text: "${rejection}")`);
      throw new Error(`no reaction prompt reached the GM; player rejection: "${rejection}"`);
    }
    await prompt.first().click();
    const resolve = gm.locator('[data-testid^="reaction-resolve-"]');
    await expect(resolve.first()).toBeVisible();
    await resolve.first().click();
    await expect(resolve).toHaveCount(0);
    return 'GM triggered and resolved the opportunity attack';
  });

  await phase('Turn advance: player ends turn, round continues', async () => {
    const endTurn = pl.getByTestId('combat-next');
    if (await endTurn.isVisible()) await endTurn.click();
    else await gm.getByTestId('combat-next').click();
    await expect(gm.getByTestId('combat-active')).not.toContainText(PC_NAME);
    return (await gm.getByTestId('combat-active').innerText()).trim();
  });

  await phase('GM damages the monster, undoes it, then bloodies it', async () => {
    await gm.getByTestId(`token-${monsterTokenId}`).click();
    const hpText = gm.getByTestId('vitals-hp');
    const start = hpOf(await hpText.innerText());
    await gm.getByTestId('vitals-amount').fill('3');
    await gm.getByTestId('vitals-damage').click();
    await expect(hpText).toContainText(`HP ${start.hp - 3} /`);
    await gm.getByTestId('gm-undo').click();
    await expect(hpText).toContainText(`HP ${start.hp} /`);
    const bloody = start.hp - Math.floor(start.max / 2) + 1;
    await gm.getByTestId('vitals-amount').fill(String(bloody));
    await gm.getByTestId('vitals-damage').click();
    await expect(hpText).toContainText(`HP ${start.hp - bloody} /`);
    await expect(pl.getByTestId(`token-${monsterTokenId}`)).toHaveAttribute('aria-label', /Bloodied/);
    await pl.getByTestId(`token-${monsterTokenId}`).click();
    await expect(pl.getByTestId('vitals-hp')).toHaveText('Bloodied');
    await expect(pl.getByTestId('vitals-damage')).toHaveCount(0);
    await shot(both, 'monster-bloodied');
    return `monster ${start.hp}/${start.max} -> undo restored -> ${start.hp - bloody}`;
  });

  await phase('GM damages and heals the PC; player sees exact own HP', async () => {
    await gm.getByTestId(`token-${pcTokenId}`).click();
    const start = hpOf(await gm.getByTestId('vitals-hp').innerText());
    await gm.getByTestId('vitals-amount').fill('4');
    await gm.getByTestId('vitals-damage').click();
    await expect(gm.getByTestId('vitals-hp')).toContainText(`HP ${start.hp - 4} /`);
    await gm.getByTestId('vitals-amount').fill('2');
    await gm.getByTestId('vitals-heal').click();
    await expect(gm.getByTestId('vitals-hp')).toContainText(`HP ${start.hp - 2} /`);
    await pl.getByTestId(`token-${pcTokenId}`).click();
    await expect(pl.getByTestId('vitals-hp')).toContainText(`HP ${start.hp - 2} / ${start.max}`);
    const sheet = await (await pl.request.get(campaignApi(`/actors/${pcActorId}`))).json();
    await shot(both, 'pc-healed');
    return `PC ${start.hp} -> ${start.hp - 4} -> ${start.hp - 2}; sheet hp ${JSON.stringify(sheet?.actor?.data?.attributes?.hp ?? null)}`;
  });

  const openSheetFor = async (page: Page, tokenId: string) => {
    await page.getByTestId(`token-${tokenId}`).click();
    await page.getByTestId('vitals-open-sheet').click();
    await expect(page.getByTestId('hud-sheet-drawer')).toBeVisible();
  };
  /** Clicks through the sheet tabs until `target` shows. */
  const revealInSheet = async (page: Page, target: Locator) => {
    const tabs = page.getByTestId('hud-sheet-drawer').locator('[data-testid^="tab-btn-"]');
    for (let i = 0; i < (await tabs.count()) && !(await target.first().isVisible()); i++) await tabs.nth(i).click();
    await expect(target.first()).toBeVisible();
  };
  /** Health tier the player must see for `hp` of `max` (either one exactly at half). */
  const tierFor = (hp: number, max: number) => (hp * 2 < max ? /Bloodied/ : hp * 2 > max ? /Unhurt/ : /Unhurt|Bloodied/);
  const assertPublicOnly = (tokenId: string) => {
    expect(latestState(plFrames)?.tokens[tokenId], 'the monster is never a controlled token for the player').toBeUndefined();
    for (const s of states(plFrames)) {
      const pub = s.public_tokens?.[tokenId];
      if (pub) for (const secret of ['hp', 'max_hp', 'temp_hp', 'ac', 'stat_block']) expect(Object.keys(pub)).not.toContain(secret);
    }
  };

  let srdTokenId = '';
  const srdHp = () => Number(latestState(gmFrames)?.tokens[srdTokenId]?.hp);

  await phase('GM spawns an SRD monster from the compendium; the server fills HP and AC; the player sees a tier only', async () => {
    await openTab(gm, 'compendium');
    await gm.getByTestId('compendium-tab-monster').click();
    await gm.getByTestId('compendium-search-input').fill(SRD_MONSTER.name);
    await gm.getByTestId(`btn-stat-block-${SRD_MONSTER.slug}`).click();
    await expect(gm.getByTestId(`stat-block-${SRD_MONSTER.slug}`)).toBeVisible();
    await shot({ gm }, 'gm-compendium-monster');
    await gm.getByTestId(`btn-spawn-${SRD_MONSTER.slug}`).click();
    await expect(gm.getByTestId('workspace-spawn-status')).toContainText(SRD_MONSTER.name);
    const spawned = () => Object.values(latestState(gmFrames)?.tokens ?? {}).find((t) => String(t.name).startsWith(SRD_MONSTER.name));
    await expect.poll(() => spawned()?.id ?? null).not.toBeNull();
    const token = spawned()!;
    srdTokenId = String(token.id);
    expect({ hp: token.hp, max: token.max_hp, ac: token.ac }, 'server-derived vitals from the SRD stat block').toEqual({
      hp: SRD_MONSTER.hp,
      max: SRD_MONSTER.hp,
      ac: SRD_MONSTER.ac,
    });
    expect(token.stat_block, 'the GM token carries the server copy of the stat block').toBeTruthy();
    await openTab(gm, 'table');
    await gm.getByTestId(`token-${srdTokenId}`).click();
    await expect(gm.getByTestId('vitals-hp')).toContainText(`HP ${SRD_MONSTER.hp} / ${SRD_MONSTER.hp}`);
    const plToken = pl.getByTestId(`token-${srdTokenId}`);
    await expect(plToken).toHaveAttribute('aria-label', /Unhurt/);
    await plToken.click();
    await expect(pl.getByTestId('vitals-hp')).toHaveText('Unhurt');
    assertPublicOnly(srdTokenId);
    await shot(both, 'srd-monster-spawned');
    const pc = latestState(gmFrames)?.tokens[pcTokenId];
    return `${token.name} at ${JSON.stringify(token.top_left)} (PC at ${JSON.stringify(pc?.top_left)}): HP ${token.hp}/${token.max_hp}, AC ${token.ac}`;
  });

  await phase('GM attacks the SRD monster from the NPC sheet, reviews and Applies; the player sees the tier only', async () => {
    const before = srdHp();
    await openSheetFor(gm, monsterTokenId);
    const resolve = gm.locator('[data-testid^="btn-atk-resolve-"]');
    await revealInSheet(gm, resolve);
    const attack = (await resolve.first().getAttribute('aria-label')) ?? '';
    await resolve.first().click();
    const card = gm.getByTestId('action-card');
    await expect(card).toBeVisible();
    await gm.getByTestId(`action-target-${srdTokenId}`).check();
    await gm.getByTestId('action-roll').click();
    await expect(gm.getByTestId(`action-result-${srdTokenId}`)).toBeVisible();
    const outcome = (await gm.getByTestId(`action-outcome-${srdTokenId}`).innerText()).trim();
    expect(outcome, 'the GM sees the AC, so the outcome is decided').toMatch(/^(Hit|Critical hit|Miss)$/);
    const amount = gm.getByTestId(`action-damage-${srdTokenId}`);
    let damage = Number(await amount.inputValue());
    expect(damage > 0, `${outcome} rolls damage only on a hit`).toBe(outcome !== 'Miss');
    let adjusted = '';
    if (damage === 0) {
      damage = 6;
      await amount.fill(String(damage));
      adjusted = ' (miss; GM adjusted the amount to 6)';
    }
    await shot(both, 'attack-review');
    await gm.getByTestId('action-apply').click();
    await expect(card).toBeHidden();
    await expect.poll(srdHp).toBe(before - damage);
    await gm.getByTestId(`token-${srdTokenId}`).click();
    await expect(gm.getByTestId('vitals-hp')).toContainText(`HP ${before - damage} /`);
    const tier = tierFor(before - damage, SRD_MONSTER.hp);
    await expect(pl.getByTestId(`token-${srdTokenId}`)).toHaveAttribute('aria-label', tier);
    await pl.getByTestId(`token-${srdTokenId}`).click();
    await expect(pl.getByTestId('vitals-hp')).toHaveText(tier);
    assertPublicOnly(srdTokenId);
    await shot(both, 'attack-applied');
    return `${attack}: ${outcome}, ${damage} damage${adjusted}; HP ${before} -> ${before - damage}`;
  });

  await phase('Level-1 Wizard sheet shows two level-1 slots; casting Mage Armor spends one', async () => {
    await openSheetFor(pl, pcTokenId);
    const count = pl.getByTestId('slot-count-1');
    await revealInSheet(pl, count);
    await expect(count).toHaveText('2/2');
    await shot({ player: pl }, 'player-spell-slots');
    const saved = pl.waitForResponse((r) => r.url().includes(`/actors/${pcActorId}`) && r.request().method() === 'PUT');
    await pl.getByTestId('btn-cast-spell-srd:spell:mage_armor').click();
    expect((await saved).status()).toBe(200);
    await expect(pl.getByTestId('hud-sheet-drawer'), 'casting on the table closes the drawer').toBeHidden();
    await openSheetFor(pl, pcTokenId);
    await revealInSheet(pl, count);
    await expect(count).toHaveText('1/2');
    const stored = await (await pl.request.get(campaignApi(`/actors/${pcActorId}`))).json();
    expect(stored?.actor?.data?.spellSlots?.level1, 'the spent slot is stored on the sheet').toEqual({ current: 1, max: 2 });
    await closeSheet(pl);
    return 'level-1 slots 2/2 -> 1/2 after Mage Armor';
  });

  await phase('GM casts Burning Hands from the Wizard sheet at the SRD monster; DEX save rolled; save-for-half applied', async () => {
    const before = srdHp();
    await openSheetFor(gm, pcTokenId);
    const cast = gm.getByTestId('btn-cast-spell-srd:spell:burning_hands');
    await revealInSheet(gm, cast);
    const slotsSeen = (await gm.getByTestId('slot-count-1').innerText()).trim();
    const rolls: Array<{ reason: string; total: number }> = [];
    const onRoll = async (res: Response) => {
      if (!res.url().includes('/dice/roll') || res.request().method() !== 'POST') return;
      const body = res.request().postDataJSON() as { reason?: string } | null;
      const json = (await res.json().catch(() => null)) as { roll?: { total?: number } } | null;
      rolls.push({ reason: String(body?.reason ?? ''), total: Number(json?.roll?.total) });
    };
    gm.on('response', onRoll);
    const saved = gm.waitForResponse((r) => r.url().includes(`/actors/${pcActorId}`) && r.request().method() === 'PUT');
    await cast.click();
    expect((await saved).status(), 'the GM spends the Wizard slot').toBe(200);
    const card = gm.getByTestId('action-card');
    await expect(card).toBeVisible();
    await gm.getByTestId('action-area-token').selectOption(srdTokenId);
    await gm.getByTestId('action-area-project').click();
    await expect(gm.getByTestId(`action-result-${srdTokenId}`)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => rolls.find((r) => r.reason.endsWith(': damage'))?.total ?? null).not.toBeNull();
    gm.off('response', onRoll);
    const raw = rolls.find((r) => r.reason.endsWith(': damage'))!.total;
    const outcome = (await gm.getByTestId(`action-outcome-${srdTokenId}`).innerText()).trim();
    expect(outcome, 'the GM sees the save bonus, so the save is rolled').toMatch(/^Save (succeeded|failed)$/);
    const expected = outcome === 'Save succeeded' ? Math.floor(raw / 2) : raw;
    await expect(gm.getByTestId(`action-damage-${srdTokenId}`)).toHaveValue(String(expected));
    const unknown = gm.locator('[data-testid^="action-rule-"][data-testid$="-failure"]');
    for (let i = 0; i < 10 && (await unknown.count()) > 0; i++) await unknown.first().click();
    const amounts = gm.locator('input[data-testid^="action-damage-"]');
    const affected = await amounts.count();
    for (let i = 0; i < affected; i++) {
      if ((await amounts.nth(i).getAttribute('data-testid')) !== `action-damage-${srdTokenId}`) await amounts.nth(i).fill('0');
    }
    await shot(both, 'area-review');
    await gm.getByTestId('action-apply').click();
    await expect(card).toBeHidden();
    await expect.poll(srdHp).toBe(before - expected);
    await gm.getByTestId(`token-${srdTokenId}`).click();
    await expect(gm.getByTestId('vitals-hp')).toContainText(`HP ${before - expected} /`);
    await expect(pl.getByTestId(`token-${srdTokenId}`)).toHaveAttribute('aria-label', tierFor(before - expected, SRD_MONSTER.hp));
    assertPublicOnly(srdTokenId);
    await shot(both, 'area-applied');
    return `GM saw slots ${slotsSeen}; ${affected} token(s) in the cone; 3d6 = ${raw}, ${outcome} -> ${expected}; monster HP ${before} -> ${before - expected}`;
  });

  /** `DiceRolled` frames a page received; the tray itself only lists the last 8 rolls. */
  const rollsSeen = (frames: RecordedFrame[]) => frames.filter((f) => f.tag === 'DiceRolled').length;

  await phase('Dice: table tray (WebSocket) roll seen by both', async () => {
    const gmLog = gm.getByTestId('tray-log').locator('li');
    const plLog = pl.getByTestId('tray-log').locator('li');
    const gmBefore = rollsSeen(gmFrames);
    const plBefore = rollsSeen(plFrames);
    await pl.getByTestId('tray-expression').fill('1d20+5');
    await pl.getByTestId('tray-roll').click();
    await expect.poll(() => rollsSeen(plFrames)).toBe(plBefore + 1);
    await expect.poll(() => rollsSeen(gmFrames)).toBe(gmBefore + 1);
    await expect(plLog.first()).toContainText('1d20+5');
    await expect(gmLog.first()).toContainText('1d20+5');
    return (await gmLog.first().innerText()).replace(/\s+/g, ' ');
  });

  await phase('Dice: sheet roll (REST) reaches both dice logs', async () => {
    const gmLog = gm.getByTestId('tray-log').locator('li');
    const gmBefore = rollsSeen(gmFrames);
    await pl.getByTestId(`token-${pcTokenId}`).click();
    await pl.getByTestId('vitals-open-sheet').click();
    await expect(pl.getByTestId('hud-sheet-drawer')).toBeVisible();
    let roll = pl.locator('[data-testid^="save-roll-"]').first();
    if (!(await roll.isVisible())) {
      const tabs = pl.locator('[data-testid^="tab-btn-"]');
      for (let i = 0; i < (await tabs.count()) && !(await roll.isVisible()); i++) await tabs.nth(i).click();
      roll = pl.locator('[data-testid^="save-roll-"]').first();
    }
    const rolled = pl.waitForResponse((r) => r.url().includes('/dice/roll'));
    await roll.click();
    expect((await rolled).status()).toBe(200);
    await expect.poll(() => rollsSeen(gmFrames)).toBe(gmBefore + 1);
    await shot(both, 'dice-logs');
    await closeSheet(pl);
    return (await gmLog.first().innerText()).replace(/\s+/g, ' ');
  });

  await phase('Documents: GM note with handout; GM-only note', async () => {
    await openTab(gm, 'documents');
    await expect(gm.getByTestId('tab-documents')).toBeVisible();
    await gm.getByTestId('create-note-btn').click();
    await gm.getByTestId('note-title-input').fill('Crypt Lore');
    await gm.getByTestId('note-scope-select').selectOption('PARTY');
    await gm.getByTestId('note-content-editor').fill(
      [
        'The crypt smells of old incense and wet stone.',
        ':::dm',
        'Grak hides a cursed ring under the altar.',
        ':::',
        ':::handout{id="ancient-map" title="Ancient Map"}',
        'A faded map marks a hidden stair behind the east wall.',
        ':::',
      ].join('\n'),
    );
    const saved = gm.waitForResponse((r) => r.url().includes('/notes/') && r.request().method() === 'PUT');
    await gm.getByTestId('save-note-btn').click();
    expect((await saved).status()).toBeLessThan(300);
    await gm.getByTestId('create-note-btn').click();
    await gm.getByTestId('note-title-input').fill('GM Secrets');
    await gm.getByTestId('note-scope-select').selectOption('DM_ONLY');
    await gm.getByTestId('note-content-editor').fill('The innkeeper is a cultist.');
    const saved2 = gm.waitForResponse((r) => r.url().includes('/notes/') && r.request().method() === 'PUT');
    await gm.getByTestId('save-note-btn').click();
    expect((await saved2).status()).toBeLessThan(300);
    await shot({ gm }, 'gm-documents');
  });

  await phase('Handout reveal reaches the player as a modal', async () => {
    await gm.locator('[data-testid^="note-item-"]', { hasText: 'Crypt Lore' }).click();
    await gm.getByTestId('btn-reveal-handout').first().click();
    await expect(pl.getByTestId('handout-reveal-modal')).toBeVisible({ timeout: 15_000 });
    await expect(pl.getByTestId('handout-title')).toHaveText('Ancient Map');
    await expect(pl.getByTestId('handout-content')).toContainText('hidden stair');
    await shot(both, 'handout-revealed');
    await pl.getByTestId('close-handout-modal').click();
    const gmModal = gm.getByTestId('close-handout-modal');
    if (await gmModal.isVisible()) await gmModal.click();
    await openTab(pl, 'documents');
    await expect(pl.getByTestId('past-handouts-gallery')).toContainText('Ancient Map');
    await openTab(pl, 'table');
  });

  await phase('Player projection: GM-only notes and :::dm blocks withheld', async () => {
    await openTab(pl, 'documents');
    await expect(pl.getByTestId('tab-documents')).toContainText('Crypt Lore');
    await expect(pl.getByTestId('tab-documents')).not.toContainText('GM Secrets');
    await pl.locator('[data-testid^="note-item-"]', { hasText: 'Crypt Lore' }).click();
    await expect(pl.getByTestId('note-content-editor')).not.toHaveValue(/cursed ring/);
    const body = await (await pl.request.get(campaignApi('/notes'))).text();
    expect(body).not.toContain('GM Secrets');
    expect(body).not.toContain('cultist');
    expect(body).not.toContain('cursed ring');
    await shot({ player: pl }, 'player-documents');
  });

  await phase('Player saving a party note keeps the GM-only directives', async () => {
    const editor = pl.getByTestId('note-content-editor');
    await editor.fill(`${await editor.inputValue()}\nThe party mapped the first corridor.`);
    const saved = pl.waitForResponse((r) => r.url().includes('/notes/') && r.request().method() === 'PUT');
    await pl.getByTestId('save-note-btn').click();
    const status = (await saved).status();
    const stored = await (await gm.request.get(campaignApi('/notes'))).text();
    expect(stored, 'the :::dm block survives a player save').toContain('cursed ring');
    expect(stored, 'the handout block survives a player save').toContain('ancient-map');
    return `player PUT ${status}`;
  });

  await phase('Player campaign export is refused (403)', async () => {
    const res = await pl.request.get(campaignApi('/export'));
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FORBIDDEN');
    return `player GET /export -> ${res.status()} ${body.code}`;
  });

  await phase('Network drop: player goes offline, reconnects, and the next action syncs', async () => {
    await openTab(pl, 'table');
    await openTab(gm, 'table');
    const banner = pl.getByTestId('connection-banner');
    await expect(banner).toHaveAttribute('data-state', 'open');
    await plCtx.setOffline(true);
    await expect(banner).toHaveAttribute('data-state', /^(offline|reconnecting)$/, { timeout: 30_000 });
    await expect(banner).toHaveClass(/ds-connection-banner/);
    const dropped = await banner.getAttribute('data-state');
    await shot(both, 'player-offline');
    await plCtx.setOffline(false);
    await expect(banner).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
    await expect(banner).toHaveClass(/ds-visually-hidden/);
    const gmLog = gm.getByTestId('tray-log').locator('li');
    const gmBefore = rollsSeen(gmFrames);
    await pl.getByTestId('tray-expression').fill('1d6+1');
    await pl.getByTestId('tray-roll').click();
    await expect.poll(() => rollsSeen(gmFrames)).toBe(gmBefore + 1);
    await expect(gmLog.first()).toContainText('1d6+1');
    return `banner ${dropped} -> open; post-reconnect roll reached the GM`;
  });

  await phase('Crash setup: GM damages the PC and undoes it before the harness kills the server', async () => {
    await gm.getByTestId(`token-${pcTokenId}`).click();
    const hpText = gm.getByTestId('vitals-hp');
    const start = hpOf(await hpText.innerText());
    await gm.getByTestId('vitals-amount').fill('5');
    await gm.getByTestId('vitals-damage').click();
    await expect(hpText).toContainText(`HP ${start.hp - 5} /`);
    await gm.getByTestId('gm-undo').click();
    await expect(hpText).toContainText(`HP ${start.hp} /`);
    await pl.getByTestId(`token-${pcTokenId}`).click();
    await expect(pl.getByTestId('vitals-hp')).toContainText(`HP ${start.hp} / ${start.max}`);
    const handoff: CrashHandoff = {
      campaignId,
      pcTokenId,
      pcHp: start.hp,
      pcMaxHp: start.max,
      gmEmail: GM.email,
      playerEmail: PLAYER.email,
    };
    writeFileSync(CRASH_HANDOFF, JSON.stringify(handoff, null, 2));
    await shot(both, 'pre-crash-undone');
    return `PC ${start.hp} -> ${start.hp - 5} -> undo -> ${start.hp}; handoff written`;
  });

  await phase('Final table state on both screens', async () => {
    await openTab(gm, 'table');
    await openTab(pl, 'table');
    await gm.waitForTimeout(1500);
    await shot(both, 'final');
  });

  await phase('Brand fonts load in both browsers', async () => {
    const summaries: string[] = [];
    for (const [who, page] of Object.entries(both)) {
      const faces = await page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].map((f) => ({ family: f.family.replace(/"/g, ''), weight: f.weight, status: f.status }));
      });
      for (const family of ['Space Grotesk', 'IBM Plex Sans']) {
        expect(faces.some((f) => f.family === family && f.status === 'loaded'), `${who}: ${family} loaded`).toBe(true);
      }
      expect(faces.filter((f) => f.status === 'error'), `${who}: no font face failed`).toEqual([]);
      summaries.push(`${who}: ${faces.filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`).join(', ')}`);
    }
    expect(fontErrors, 'no font decode errors').toEqual([]);
    return summaries.join(' | ');
  });

  await phase('No CSP violations in either browser', async () => {
    expect(cspViolations).toEqual([]);
    return `${cspViolations.length} violations`;
  });

  await gm.waitForTimeout(1000);
  writeFileSync(join(ARTIFACTS, 'console.log'), consoleLog.join('\n'));
  writeFileSync(join(ARTIFACTS, 'csp-violations.log'), cspViolations.join('\n'));
  writeFileSync(join(ARTIFACTS, 'frames-player.json'), JSON.stringify(plFrames.map((f: RecordedFrame) => f.tag)));
  writeFileSync(join(ARTIFACTS, 'phases.json'), JSON.stringify({ results, notes }, null, 2));
  await gmCtx.close();
  await plCtx.close();
  await gm.video()?.saveAs(join(ARTIFACTS, 'gm.webm'));
  await pl.video()?.saveAs(join(ARTIFACTS, 'player.webm'));
  printPhases();
});

test('after a SIGKILL and restart the table shows the undone state', async ({ browser }) => {
  test.skip(STAGE !== 'after-restart', 'runs only after `make e2e` kills and restarts trame-server');
  test.setTimeout(5 * 60_000);
  mkdirSync(SCREENS, { recursive: true });
  const handoff = JSON.parse(readFileSync(CRASH_HANDOFF, 'utf8')) as CrashHandoff;
  const context = () => browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: VIEWPORT, locale: 'en-US' });
  const gmCtx = await context();
  const plCtx = await context();
  const gm = await gmCtx.newPage();
  const pl = await plCtx.newPage();
  const gmFrames = recordRoomFrames(gm);
  const phase = phaseRunner({ gm, player: pl }, 0);

  await phase('Server is back after SIGKILL', async () => {
    await expect
      .poll(async () => (await gm.request.get('/healthz').catch(() => null))?.status() ?? 0, { timeout: 90_000 })
      .toBe(200);
  });

  await phase('GM signs in again: the recovered table shows the undone HP (no ghost damage)', async () => {
    await signInToTable(gm, handoff.gmEmail, handoff.campaignId);
    await expect.poll(() => latestState(gmFrames)?.tokens[handoff.pcTokenId]?.hp ?? null).toBe(handoff.pcHp);
    await gm.getByTestId(`token-${handoff.pcTokenId}`).click();
    await expect(gm.getByTestId('vitals-hp')).toContainText(`HP ${handoff.pcHp} / ${handoff.pcMaxHp}`);
    const quarantine = gm.getByTestId('wal-quarantine-banner');
    if (await quarantine.evaluate((el) => el.classList.contains('ds-connection-banner'))) {
      note(`GM quarantine banner after recovery: ${(await quarantine.innerText()).replace(/\s+/g, ' ')}`);
    }
    await shot({ gm }, 'after-restart-gm');
    return `PC token hp ${handoff.pcHp}/${handoff.pcMaxHp} after WAL recovery`;
  });

  await phase('Player signs in again and sees the same exact own HP', async () => {
    await signInToTable(pl, handoff.playerEmail, handoff.campaignId);
    await pl.getByTestId(`token-${handoff.pcTokenId}`).click();
    await expect(pl.getByTestId('vitals-hp')).toContainText(`HP ${handoff.pcHp} / ${handoff.pcMaxHp}`);
    await shot({ player: pl }, 'after-restart-player');
  });

  writeFileSync(join(ARTIFACTS, 'phases-after-restart.json'), JSON.stringify({ results, notes }, null, 2));
  await gmCtx.close();
  await plCtx.close();
  printPhases();
});
