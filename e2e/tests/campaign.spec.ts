/**
 * ============================================================================
 * TWO-BROWSER CAMPAIGN JOURNEY: GM + PLAYER (campaign.spec.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Drives one full D&D 5e session through the real UI with two simultaneous
 * browser contexts (GM and player), each recording video: sign-up, campaign
 * and invite, character creation, map import and activation, tokens,
 * initiative, movement and reactions, damage/heal/undo, dice, sheet conflict,
 * documents and handouts, and the player projection rules.
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
 *
 * EXECUTION LIFECYCLE:
 * -----
 * GM signs up -> campaign -> invite -> player redeems -> characters (both)
 * -> sheet edit + version conflict -> UVTT import + background + secret door
 * + GM light + hidden goblin -> activate -> tokens -> WebGL renderer, fog,
 * GM vision preview, night + lights (pixel probes) -> projection checks -> combat ->
 * player reload (initiative after reconnect) -> movement / opportunity
 * attack -> damage, undo, heal -> dice (WS + REST) -> documents + handout
 * -> fonts + CSP checks -> videos saved under `artifacts/`.
 * ============================================================================
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const PC_NAME = 'Lyra Thornwood';
const MONSTER_NAME = 'Grak the Goblin Boss';
const CAMPAIGN = `Crypt of Embers ${RUN}`;
/** Pause after each phase so the recording can be followed by eye (ms). */
const PHASE_PAUSE_MS = 1000;
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

function hpOf(text: string): { hp: number; max: number } {
  const m = /HP (\d+) \/ (\d+)/.exec(text);
  if (!m) throw new Error(`no HP in "${text}"`);
  return { hp: Number(m[1]), max: Number(m[2]) };
}

test('GM and player play one campaign session end to end', async ({ browser }) => {
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

  /** Runs one journey phase; failures become soft failures with screenshots. */
  const phase = async (name: string, fn: () => Promise<string | void>) => {
    await test.step(name, async () => {
      try {
        const detail = (await fn()) ?? '';
        results.push({ phase: name, status: 'pass', note: detail });
        await gm.waitForTimeout(PHASE_PAUSE_MS);
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '');
        results.push({ phase: name, status: 'fail', note: message });
        await shot(both, `FAIL-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
        expect.soft(message, `phase "${name}" failed`).toBe('');
      }
    });
  };

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

  await phase('GM signs up through the auth screen', async () => {
    await gm.goto('/');
    await expect(gm.getByTestId('auth-screen')).toBeVisible();
    await gm.getByTestId('auth-mode-register').click();
    await gm.getByTestId('auth-email').fill(GM.email);
    await gm.getByTestId('auth-display-name').fill(GM.name);
    await gm.getByTestId('auth-password').fill(PASSWORD);
    await shot({ gm }, 'gm-register');
    await gm.getByTestId('auth-submit').click();
    await expect(gm.getByTestId('campaign-lobby')).toBeVisible();
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
  await phase('GM mints an invite link', async () => {
    await gm.getByTestId(`lobby-invite-${campaignId}`).click();
    const field = gm.getByTestId(`lobby-invite-url-${campaignId}`);
    await expect(field).toHaveValue(/invite=/);
    inviteUrl = await field.inputValue();
    await shot({ gm }, 'gm-invite');
    return inviteUrl.replace(/invite=.*/, 'invite=<jwt>');
  });

  await phase('Player redeems the invite and lands in the campaign', async () => {
    const url = new URL(inviteUrl);
    await pl.goto(`${url.pathname}${url.search}`);
    await expect(pl.getByTestId('campaign-workspace')).toBeVisible();
    await expect(pl).not.toHaveURL(/invite=/);
    await expect(pl.getByTestId('trame-status-badge')).toBeVisible();
    await gm.getByTestId(`lobby-open-${campaignId}`).click();
    await expect(gm.getByTestId('campaign-workspace')).toBeVisible();
    await shot(both, 'joined');
  });

  /** Walks the six-step creation modal (2024 origins) and returns the new actor id. */
  const createCharacter = async (page: Page, name: string, classId: string) => {
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
    await page.getByTestId('builder-next').click();
    await expect(page.getByTestId('builder-step-equipment')).toBeVisible();
    await page.getByTestId('builder-equipment-package').check();
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

  await phase('Player creates a character (species, class, background)', async () => {
    const pc = await createCharacter(pl, PC_NAME, 'fighter');
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

  await phase('GM adds a secret door and a hidden goblin, reveals, saves, activates', async () => {
    await gm.locator('[data-testid^="scene-item-"]').first().click();
    await gm.getByTestId('wall-type-select').selectOption('SecretDoor');
    await gm.getByTestId('wall-p1x-input').fill('420');
    await gm.getByTestId('wall-p1y-input').fill('420');
    await gm.getByTestId('wall-p2x-input').fill('560');
    await gm.getByTestId('wall-p2y-input').fill('420');
    await gm.getByTestId('add-wall-btn').click();
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
    const rejection = (await pl.getByTestId('table-rejection').innerText()).trim();
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

  await phase('Dice: table tray (WebSocket) roll seen by both', async () => {
    const gmLog = gm.getByTestId('tray-log').locator('li');
    const plLog = pl.getByTestId('tray-log').locator('li');
    const gmBefore = await gmLog.count();
    const plBefore = await plLog.count();
    await pl.getByTestId('tray-expression').fill('1d20+5');
    await pl.getByTestId('tray-roll').click();
    await expect(plLog).toHaveCount(plBefore + 1);
    await expect(gmLog).toHaveCount(gmBefore + 1);
    await expect(gmLog.first()).toContainText('1d20+5');
    return (await gmLog.first().innerText()).replace(/\s+/g, ' ');
  });

  await phase('Dice: sheet roll (REST) reaches both dice logs', async () => {
    const gmLog = gm.getByTestId('tray-log').locator('li');
    const gmBefore = await gmLog.count();
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
    await expect(gmLog).toHaveCount(gmBefore + 1);
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
  console.log(results.map((r) => `${r.status.toUpperCase().padEnd(4)} ${r.phase}${r.note ? ` — ${r.note}` : ''}`).join('\n'));
});
