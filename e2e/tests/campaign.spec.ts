/**
 * ============================================================================
 * MULTI-BROWSER CAMPAIGN JOURNEY: GM + THREE PLAYERS (campaign.spec.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Drives one full D&D 5e session through the real UI with four simultaneous
 * browser contexts in one Chromium (GM and player one recorded on video,
 * players two and three unrecorded): Owner setup, one campaign invite
 * redeemed by three players then revoked, character creation (a level-1
 * Wizard), map import and activation with the battlemap stored in S3 (Silo),
 * doors (and the player's 5 ft door reach), conditions and GM rulings,
 * tokens, initiative, movement and reactions, damage/heal/undo, SRD
 * monsters spawned hidden from the compendium, player attacks and area
 * spells resolved by the server as pending resolutions (ADR-0042) with an
 * explicit Apply, a GM monster attack from the stat block panel,
 * concentration checks, spell slots, dice, sheet conflict, documents and
 * handouts, the player projection rules, HTTP and WebSocket compression,
 * unchanged-projection frame skipping (RT12), and, with every browser still
 * open, a SIGKILL, a graceful restart, and a backup restored onto a wiped
 * database.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Assert Outcomes, Keep Going`:
 *    - Every phase runs in `phase()`: a failure is recorded as a soft failure
 *      with screenshots of the GM and player-one pages and the journey
 *      continues, so one report covers the whole flow. The test still fails
 *      if any phase did.
 * 2. `Projection Checked On The Wire`:
 *    - Player secrecy (monster HP/AC, GM-hidden tokens, secret doors, GM
 *      notes) is asserted on the decoded socket frames and REST payloads the
 *      player received, not only on what the UI rendered.
 * 3. `Production Hardening Observed From The Browser`:
 *    - Every `securitypolicyviolation` and CSP console message in any
 *      context fails the run, as do brand font faces that are not `loaded`
 *      or font decode errors; index.html must carry the app CSP while API
 *      responses keep the strict one.
 * 4. `Pixels, Not DOM, For The Renderer`:
 *    - The battlemap, darkness, lights and fog are asserted on composited
 *      screenshots of the WebGL board (`support/pixels.ts` probes), comparing
 *      GM and player and before/after states rather than absolute colours.
 *    - The uploaded background is green-tinted (G > R) while the UVTT image
 *      is warm grey (R > G), so a green probe proves the S3 texture is drawn.
 * 5. `Synchronized, Readable Recordings`:
 *    - The GM and player-one contexts are created and closed together, so
 *      `gm.webm` and `player.webm` share one timeline for the side-by-side
 *      video; players two and three are not recorded to keep it readable.
 * 6. `Invite-Only Accounts, No Backdoor`:
 *    - The GM claims the fresh instance as `Owner` through the real setup URL
 *      the server logged (`owner_bootstrap_url`), which `make e2e` passes in
 *      as `E2E_SETUP_URL`; the three player accounts are created by
 *      redeeming one `CampaignInvite` link (4 uses), which the GM then
 *      revokes. URLs are opened by path and query against `baseURL`, so they
 *      work whatever origin `TRAME_PUBLIC_ORIGIN` names.
 * 7. `Stack Operations Mid-Session, No Server Backdoor`:
 *    - The browsers reach the server through `support/forward.ts`, so the
 *      host harness (`scripts/run-e2e.sh`, asked through
 *      `support/harness.ts`) can SIGKILL, restart, back up and restore it
 *      while every page stays open. Recovery is asserted on the first
 *      `StateSnapshot` each page receives after its socket reconnects on its
 *      own: the WAL-recovered table shows the undone HP, a pending resolution
 *      left unapplied before the kill still applies exactly once, and a note
 *      written after the backup is gone once the dump is restored.
 * 8. `Server-Side Resolution Against Monsters (ADR-0042)`:
 *    - The player attacks and blasts the SRD monster; the server rolls
 *      against its hidden AC and save bonus. The player sees outcome and
 *      damage only (no d20, no total, on screen or on the wire); the GM sees
 *      the same resolution in the pending list with its rolls.
 *    - A missed attack is never stored as pending (nothing to apply), so the
 *      player attacks until the server reports a hit (bounded attempts).
 *    - Apply is proven idempotent by double-clicking it: two
 *      `APPLY_RESOLUTION` commands reach the server, the second is refused,
 *      and the hit points drop once.
 * 9. `Assets From The Object Store (ADR-0041)`:
 *    - Map images are fetched with `crossOrigin = "anonymous"` from
 *      `/assets/download/...`, which must answer `307` to a presigned Silo
 *      URL; Silo must answer `200` with `Access-Control-Allow-Origin` set to
 *      the app origin (the storage-init CORS rule), or WebGL would refuse the
 *      texture. Checked at first render, after the restart and after the
 *      restore.
 * 10. `Compression Seen By The Client`:
 *    - The JS bundle and API JSON carry `Content-Encoding` br/zstd/gzip, every
 *      room socket's handshake answer (read through CDP) selects
 *      `trame.v1+deflate`, and every frame is a zlib stream that inflates to
 *      a MessagePack envelope.
 * 11. `RT12 On The Wire`:
 *    - While the GM moves a GM-hidden token, no player socket receives a
 *      state frame; a lighting change right after reaches all three.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * GM claims Owner -> campaign -> invite (4 uses) -> players two and three,
 * then player one, redeem it -> GM sees 3 redemptions, revokes, a fourth
 * visitor is refused -> characters -> sheet edit + version conflict -> UVTT
 * import + background (stored in Silo) + secret door + locked door + GM
 * light + hidden goblin -> activate -> tokens -> WebGL renderer -> map image
 * through the signed redirect, drawn on both canvases -> compression (HTTP +
 * WS) -> fog, GM vision preview, night + lights (pixel probes) ->
 * projection checks -> RT12 hidden move -> door handles and vision ->
 * player door reach -> Restrained + GM ruling -> combat -> player reload ->
 * movement / opportunity attack -> damage, undo, heal -> compendium monster
 * spawned hidden, revealed -> player attack + GM double Apply -> player slot
 * spend -> player area spell + player Apply -> GM stat block attack ->
 * player concentration check -> monster privacy -> dice (WS + REST) ->
 * documents + handout -> player export refused -> offline / online
 * reconnect -> unapplied player hit left pending -> damage + undo
 * -> [harness: SIGKILL] -> sockets reconnect, undone HP, pending hit applied
 * once -> [harness: restart] -> map image again from Silo after a reload
 * -> [harness: backup] -> GM writes a note -> [harness: wipe + restore] ->
 * campaign, map and table back, the note gone -> fonts + CSP checks ->
 * videos saved under `artifacts/`.
 * ============================================================================
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backgroundPng, uvttBundle } from '../support/fixtures.ts';
import { harness } from '../support/harness.ts';
import { decodePng, meanLuma, meanRgb, type ProbeRect, type RgbaImage } from '../support/pixels.ts';
import { latestState, recordRoomFrames, recordSentCommands, states, type ProjectedState, type RecordedFrame } from '../support/wire.ts';

const ARTIFACTS = process.env.E2E_ARTIFACTS_DIR ?? 'artifacts';
const SCREENS = join(ARTIFACTS, 'screens');
const VIEWPORT = { width: 1280, height: 800 };
const RUN = Date.now().toString(36);
const PASSWORD = 'Crypt-Lantern-Quill-2026!';

const GM = { email: `gm-${RUN}@e2e.trame.test`, name: 'Game Master' };
const PLAYER = { email: `player-${RUN}@e2e.trame.test`, name: 'Player One' };
const PLAYER2 = { email: `player2-${RUN}@e2e.trame.test`, name: 'Player Two' };
const PLAYER3 = { email: `player3-${RUN}@e2e.trame.test`, name: 'Player Three' };
/** Uses the GM grants the invite: the three players redeem it, then the GM revokes it. */
const INVITE_MAX_USES = 4;
/** Owner setup URL from the server's `owner_bootstrap_url` log line (set by `make e2e`). */
const SETUP_URL = process.env.E2E_SETUP_URL ?? '';
const PC_NAME = 'Lyra Thornwood';
const MONSTER_NAME = 'Grak the Goblin Boss';
const CAMPAIGN = `Crypt of Embers ${RUN}`;
/** Pause after each phase so the recording can be followed by eye (ms). */
const PHASE_PAUSE_MS = 1000;
/** Origin of the browser-facing S3 endpoint (`S3_PUBLIC_ENDPOINT` in `e2e.env`). */
const S3_PUBLIC_ORIGIN = process.env.E2E_S3_PUBLIC_ORIGIN ?? 'http://silo:9000';
/** Subprotocol the server selects for zlib-compressed socket frames (ADR-0041, D24). */
const WS_DEFLATE = 'trame.v1+deflate';
/** Quiet time after the GM's hidden move during which no player may get a state frame (ms). */
const RT12_QUIET_MS = 2000;
/** Longest wait for a page's socket to reconnect after a harness action (ms). */
const RECONNECT_TIMEOUT_MS = 90_000;
/**
 * Minimum mean `G - R` of a board probe on the uploaded green background
 * (source cells G - R = 20 / 22, UVTT image R - G = 8 / 8): above it the S3
 * texture is drawn, below it the canvas shows the void or the wrong image.
 */
const BACKGROUND_GREEN_MIN = 6;
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
/**
 * Cell (top-left, board px) one square west of the UVTT door's upper half:
 * 5 ft from the door (the engine's `DOOR_REACH_FT`) with a clear view, and
 * clear of the door handle so both stay clickable.
 */
const DOOR_REACH_CELL = { x: 560, y: 280 };
/** Player attack attempts before giving up on a hit (a miss is never left pending). */
const MAX_ATTACK_ATTEMPTS = 15;
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

/** Unrecorded context: players two and three, and the refused fourth visitor (invariant 5). */
async function newPlainContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: VIEWPORT, locale: 'en-US' });
}

/** CDP view of one page: room socket subprotocols and a browser cache reset. */
interface CdpProbe {
  /** `Sec-WebSocket-Protocol` the server answered for each campaign room socket, in order (invariant 10). */
  protocols: string[];
  /** Drops the HTTP cache, so the next map image load really goes to the object store. */
  clearCache: () => Promise<void>;
}

/** Attaches a CDP session to `page` before it opens any socket. */
async function attachCdp(context: BrowserContext, page: Page): Promise<CdpProbe> {
  const cdp = await context.newCDPSession(page);
  const protocols: string[] = [];
  const roomSockets = new Set<string>();
  cdp.on('Network.webSocketCreated', (e) => {
    if (e.url.includes('/campaigns/')) roomSockets.add(e.requestId);
  });
  cdp.on('Network.webSocketHandshakeResponseReceived', (e) => {
    if (!roomSockets.has(e.requestId)) return;
    const header = Object.entries(e.response.headers).find(([name]) => name.toLowerCase() === 'sec-websocket-protocol');
    protocols.push(header ? String(header[1]) : '');
  });
  await cdp.send('Network.enable');
  return {
    protocols,
    clearCache: async () => {
      await cdp.send('Network.clearBrowserCache');
    },
  };
}

/** One image response from the object store, with the redirect that led to it (invariant 9). */
interface S3ImageFetch {
  status: number;
  /** `Access-Control-Allow-Origin` of the object store's answer (`''` when absent). */
  allowOrigin: string;
  /** Path of the request redirected to the object store (`/assets/download/...`). */
  redirectedFrom: string;
  /** Status of that redirect (`307`). */
  redirectStatus: number;
}

/** Records every response `page` gets from `S3_PUBLIC_ORIGIN`. */
function recordS3Images(page: Page): S3ImageFetch[] {
  const fetches: S3ImageFetch[] = [];
  page.on('response', async (res) => {
    if (!res.url().startsWith(`${S3_PUBLIC_ORIGIN}/`)) return;
    const from = res.request().redirectedFrom();
    const redirect = from ? await from.response().catch(() => null) : null;
    const headers = await res.allHeaders().catch(() => ({}) as Record<string, string>);
    fetches.push({
      status: res.status(),
      allowOrigin: headers['access-control-allow-origin'] ?? '',
      redirectedFrom: from ? new URL(from.url()).pathname : '',
      redirectStatus: redirect?.status() ?? 0,
    });
  });
  return fetches;
}

/**
 * Waits for the first `StateSnapshot` `frames` received after index `mark`,
 * i.e. the resync of a socket that reconnected after a harness action.
 */
async function snapshotAfter(frames: RecordedFrame[], mark: number): Promise<ProjectedState> {
  const fresh = () => frames.slice(mark).find((f) => f.tag === 'StateSnapshot');
  await expect.poll(() => Boolean(fresh()), { timeout: RECONNECT_TIMEOUT_MS, message: 'a StateSnapshot after the reconnect' }).toBe(true);
  return fresh()!.payload.state as ProjectedState;
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
        const message = (err instanceof Error ? err.message : String(err))
          .replace(/\u001b\[[0-9;]*m/g, '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('Call log'))
          .slice(0, 4)
          .join(' | ');
        results.push({ phase: name, status: 'fail', note: message });
        await shot(pages, `FAIL-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
        expect.soft(message, `phase "${name}" failed`).toBe('');
      }
    });
  };
}

/** One target of a wire `PendingResolution` (ADR-0042). */
interface WireResolvedTarget {
  token_id: string;
  outcome: string;
  d20_rolls: number[];
  total: number | null;
  damage: number;
  applied: boolean;
}

/** Wire `PendingResolution`: a projected entry or an `ACTION_RESOLVED` payload. */
interface WireResolution {
  id: string;
  action_name: string;
  targets: WireResolvedTarget[];
}

/** Every resolution copy `frames` carried: projected `pending_resolutions` and `ACTION_RESOLVED` events. */
function resolutionsSeen(frames: RecordedFrame[]): WireResolution[] {
  const seen: WireResolution[] = [];
  for (const f of frames) {
    if (f.tag !== 'StateSnapshot' && f.tag !== 'CommandAccepted') continue;
    const pending = (f.payload.state as Record<string, unknown> | undefined)?.pending_resolutions as Record<string, WireResolution> | undefined;
    seen.push(...Object.values(pending ?? {}));
    for (const ev of (f.payload.events ?? []) as Array<Record<string, unknown>>) {
      if (ev.event === 'ACTION_RESOLVED') seen.push(ev.resolution as WireResolution);
    }
  }
  return seen;
}

/** Newest `ACTION_RESOLVED` resolution `frames` carried, `null` before any. */
function lastResolution(frames: RecordedFrame[]): WireResolution | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const events = (frames[i].tag === 'CommandAccepted' ? frames[i].payload.events : []) as Array<Record<string, unknown>>;
    const hit = [...events].reverse().find((ev) => ev.event === 'ACTION_RESOLVED');
    if (hit) return hit.resolution as WireResolution;
  }
  return null;
}

/**
 * Double-clicks Apply on the GM's pending entry `resolutionId` (invariant 8):
 * both `APPLY_RESOLUTION` commands must reach the server, the second must be
 * refused, and `hp()` must drop by `damage` exactly once.
 */
async function doubleApplyOnce(
  gm: Page,
  gmFrames: RecordedFrame[],
  gmSent: string[],
  resolutionId: string,
  damage: number,
  hp: () => number,
): Promise<void> {
  const before = hp();
  const applies = () => gmSent.filter((cmd) => cmd === 'APPLY_RESOLUTION').length;
  const rejections = () => gmFrames.filter((f) => f.tag === 'CommandRejected').length;
  const appliesBefore = applies();
  const rejectionsBefore = rejections();
  await gm.getByTestId(`pending-${resolutionId}-apply`).dblclick();
  await expect.poll(hp).toBe(before - damage);
  await expect(gm.getByTestId(`pending-${resolutionId}`)).toHaveCount(0);
  expect(applies() - appliesBefore, 'both Apply clicks reached the server').toBe(2);
  await expect.poll(rejections, { message: 'the second Apply is refused' }).toBe(rejectionsBefore + 1);
  await gm.waitForTimeout(1000);
  expect(hp(), 'the second Apply dealt no damage').toBe(before - damage);
}

/** Board position (`px`) of a token in the latest projected state. */
function topLeftOf(frames: RecordedFrame[], tokenId: string): { x: number; y: number } | null {
  const token = latestState(frames)?.tokens[tokenId] ?? latestState(frames)?.public_tokens?.[tokenId];
  return (token?.top_left as { x: number; y: number } | undefined) ?? null;
}

function printPhases(): void {
  console.log(results.map((r) => `${r.status.toUpperCase().padEnd(4)} ${r.phase}${r.note ? ` — ${r.note}` : ''}`).join('\n'));
}

test('GM and three players play one campaign session end to end, across a SIGKILL, a restart and a restore', async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  mkdirSync(SCREENS, { recursive: true });

  const gmCtx = await newRecordedContext(browser);
  const plCtx = await newRecordedContext(browser);
  const p2Ctx = await newPlainContext(browser);
  const p3Ctx = await newPlainContext(browser);
  const gm = await gmCtx.newPage();
  const pl = await plCtx.newPage();
  const p2 = await p2Ctx.newPage();
  const p3 = await p3Ctx.newPage();
  const both = { gm, player: pl };
  const all = { gm, player: pl, player2: p2, player3: p3 };
  const gmFrames = recordRoomFrames(gm);
  const plFrames = recordRoomFrames(pl);
  const p2Frames = recordRoomFrames(p2);
  const p3Frames = recordRoomFrames(p3);
  const frameLogs = { gm: gmFrames, player: plFrames, player2: p2Frames, player3: p3Frames };
  const gmSent = recordSentCommands(gm);
  const cdp = {
    gm: await attachCdp(gmCtx, gm),
    player: await attachCdp(plCtx, pl),
    player2: await attachCdp(p2Ctx, p2),
    player3: await attachCdp(p3Ctx, p3),
  };
  const gmImages = recordS3Images(gm);
  const plImages = recordS3Images(pl);
  /** JS bundle responses the browsers loaded, with their `Content-Encoding` (invariant 10). */
  const bundleEncodings: string[] = [];
  const consoleLog: string[] = [];
  const cspViolations: string[] = [];
  const fontErrors: string[] = [];
  for (const ctx of [gmCtx, plCtx, p2Ctx, p3Ctx]) {
    await ctx.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        console.error(`[e2e-csp] ${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile}:${e.lineNumber}`);
      });
    });
  }
  for (const [who, page] of Object.entries(all)) {
    page.on('response', async (res) => {
      if (!/\/assets\/[^/]+\.js$/.test(new URL(res.url()).pathname)) return;
      const headers = await res.allHeaders().catch(() => ({}) as Record<string, string>);
      bundleEncodings.push(`${who}:${headers['content-encoding'] ?? 'identity'}`);
    });
  }
  for (const [who, page] of Object.entries(all)) {
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
  /** Board screenshot of `page` decoded for pixel probes, once the renderer drew the latest state. */
  const board = async (page: Page): Promise<RgbaImage> => {
    await page.waitForTimeout(700);
    return decodePng(await page.getByTestId('table-board').screenshot());
  };
  /** Mean `G - R` of `rect` on `page`'s board: positive on the uploaded green background (invariant 4). */
  const greenOf = async (page: Page, rect: ProbeRect) => {
    const [r, g] = meanRgb(await board(page), rect);
    return g - r;
  };
  /**
   * Waits for a new object-store image in `fetches` (after index `mark`) and
   * checks it came through the signed `307` with the CORS header (invariant 9).
   */
  const expectS3Image = async (fetches: S3ImageFetch[], mark: number) => {
    await expect.poll(() => fetches.length, { timeout: 30_000, message: 'a map image from the object store' }).toBeGreaterThan(mark);
    const fetch = fetches[fetches.length - 1];
    expect(fetch.redirectedFrom, 'the image request was redirected from the signed download route').toMatch(/^\/assets\/download\//);
    expect(fetch.redirectStatus, 'signed download answers a temporary redirect').toBe(307);
    expect(fetch.status, 'the object store serves the image').toBe(200);
    expect(fetch.allowOrigin, 'the bucket CORS rule allows the app origin').toBe(new URL(test.info().project.use.baseURL ?? '').origin);
    return fetch;
  };

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
    await gm.getByTestId('invite-max-uses').fill(String(INVITE_MAX_USES));
    await gm.getByTestId('invite-create').click();
    const field = gm.getByTestId('invite-url');
    await expect(field).toHaveValue(/invite=/);
    inviteUrl = await field.inputValue();
    await expect(gm.getByTestId('invite-status')).toBeVisible();
    await shot({ gm }, 'gm-invite');
    await gm.getByTestId('invite-dialog-close').click();
    await expect(gm.getByTestId('invite-dialog')).toBeHidden();
    return `${inviteUrl.replace(/invite=.*/, 'invite=<token>')} (${INVITE_MAX_USES} uses)`;
  });

  /** Creates `who`'s account on the invite screen of `page`; lands in the campaign workspace. */
  const redeemInvite = async (page: Page, who: { email: string; name: string }) => {
    await page.goto(pathAndQuery(inviteUrl));
    await expect(page.getByTestId('invite-redemption-screen')).toBeVisible();
    await expect(page.getByTestId('invite-campaign')).toContainText(CAMPAIGN);
    await page.getByTestId('invite-display-name').fill(who.name);
    await page.getByTestId('invite-email').fill(who.email);
    await page.getByTestId('invite-password').fill(PASSWORD);
    await page.getByTestId('invite-submit').click();
    await expect(page.getByTestId('campaign-workspace')).toBeVisible();
  };

  await phase('Players two and three create accounts from the same invite link and land in the campaign', async () => {
    await redeemInvite(p2, PLAYER2);
    await redeemInvite(p3, PLAYER3);
    for (const page of [p2, p3]) {
      const me = await (await page.request.get('/api/v1/auth/me')).text();
      expect(me, 'an invite-created account is a plain instance Member').toMatch(/"instance_role":"MEMBER"/);
    }
    return `${PLAYER2.name} and ${PLAYER3.name} joined ${CAMPAIGN}`;
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
    await shot(both, 'joined');
  });

  await phase('GM sees three redemptions (3 of 4 uses), revokes the invite, and a fourth visitor is refused', async () => {
    const list = gm.getByTestId('redemptions-list');
    for (const who of [PLAYER, PLAYER2, PLAYER3]) await expect(list).toContainText(who.name);
    await expect(gm.getByTestId('invite-uses')).toHaveText(`Used 3 of ${INVITE_MAX_USES}`);
    await gm.getByTestId('invite-revoke').click();
    await expect(gm.getByTestId('invite-status')).toHaveText('Revoked');
    await shot({ gm }, 'gm-invite-revoked');
    await gm.getByTestId('invite-dialog-close').click();
    const visitorCtx = await newPlainContext(browser);
    try {
      const visitor = await visitorCtx.newPage();
      await visitor.goto(pathAndQuery(inviteUrl));
      await expect(visitor.getByTestId('invite-unavailable')).toContainText('revoked');
      await expect(visitor.getByTestId('invite-form')).toHaveCount(0);
    } finally {
      await visitorCtx.close();
    }
    await gm.getByTestId(`lobby-open-${campaignId}`).click();
    await expect(gm.getByTestId('campaign-workspace')).toBeVisible();
    return `redemptions: ${PLAYER.name}, ${PLAYER2.name}, ${PLAYER3.name}; revoked link refused`;
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

  await phase('Map image from the object store: both browsers load the background through the signed 307 redirect, Silo answers 200 with CORS, and both canvases draw it', async () => {
    const fetched = [await expectS3Image(gmImages, 0), await expectS3Image(plImages, 0)];
    const green = { gmWest: await greenOf(gm, PROBE.west), gmEast: await greenOf(gm, PROBE.east), playerWest: await greenOf(pl, PROBE.west) };
    await shot(both, 'map-from-s3');
    for (const [probe, value] of Object.entries(green)) {
      expect(value, `${probe}: the green S3 background is drawn (mean G - R)`).toBeGreaterThan(BACKGROUND_GREEN_MIN);
    }
    return `${fetched.map((f) => `${f.redirectedFrom.slice(0, 32)}… ${f.redirectStatus} -> ${f.status} ACAO ${f.allowOrigin}`).join(' | ')}; G-R ${JSON.stringify(green)}`;
  });

  await phase('Compression: the JS bundle and API JSON arrive br/zstd/gzip-encoded; every room socket negotiated trame.v1+deflate and its zlib frames decode to MessagePack', async () => {
    expect(bundleEncodings.length, 'the browsers loaded the JS bundle').toBeGreaterThan(0);
    for (const encoding of bundleEncodings) expect(encoding, 'JS bundle Content-Encoding').toMatch(/:(br|zstd|gzip)$/);
    const json = await gm.request.get(campaignApi('/actors'), { headers: { 'accept-encoding': 'br, zstd, gzip' } });
    expect(json.status()).toBe(200);
    expect(json.headers()['content-type']).toMatch(/json/);
    const jsonEncoding = json.headers()['content-encoding'] ?? 'identity';
    expect(jsonEncoding, 'API JSON Content-Encoding').toMatch(/^(br|zstd|gzip)$/);
    expect(json.headers()['vary'] ?? '', 'compressed responses vary on Accept-Encoding').toMatch(/accept-encoding/i);
    const frameCounts: string[] = [];
    for (const [who, probe] of Object.entries(cdp)) {
      expect(probe.protocols.length, `${who}: a room socket handshake was seen`).toBeGreaterThan(0);
      expect([...new Set(probe.protocols)], `${who}: every room handshake selected ${WS_DEFLATE}`).toEqual([WS_DEFLATE]);
    }
    for (const [who, frames] of Object.entries(frameLogs)) {
      expect(frames.length, `${who}: frames received`).toBeGreaterThan(0);
      expect(frames.filter((f) => !f.deflated).length, `${who}: frames not zlib-compressed`).toBe(0);
      expect(frames.filter((f) => f.tag === 'UNDECODABLE').length, `${who}: frames that did not inflate to MessagePack`).toBe(0);
      frameCounts.push(`${who} ${frames.length}`);
    }
    return `bundles ${[...new Set(bundleEncodings)].join(', ')}; /actors JSON ${jsonEncoding}; ${WS_DEFLATE} frames: ${frameCounts.join(', ')}`;
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

  /** `StateSnapshot` + `CommandAccepted` frames in `frames` (the frames RT12 may skip). */
  const stateFrames = (frames: RecordedFrame[]) => frames.filter((f) => f.tag === 'StateSnapshot' || f.tag === 'CommandAccepted').length;
  await phase('RT12: while the GM moves a GM-hidden token, no player socket receives a state frame; the next visible change reaches all three', async () => {
    const watched = { player: plFrames, player2: p2Frames, player3: p3Frames };
    const before = Object.fromEntries(Object.entries(watched).map(([who, frames]) => [who, stateFrames(frames)]));
    const start = topLeftOf(gmFrames, hiddenTokenId);
    if (!start) throw new Error('no position for the hidden goblin');
    const goblin = gm.getByTestId(`token-${hiddenTokenId}`);
    // Keyboard only: the template goblin can sit under the PC token, which takes the click.
    await goblin.focus();
    let moved: string | null = null;
    for (const [go, back] of [
      ['ArrowRight', 'ArrowLeft'],
      ['ArrowDown', 'ArrowUp'],
      ['ArrowLeft', 'ArrowRight'],
    ]) {
      await goblin.press(go);
      const left = await expect
        .poll(() => topLeftOf(gmFrames, hiddenTokenId), { timeout: 3_000 })
        .not.toEqual(start)
        .then(() => true)
        .catch(() => false);
      if (!left) continue;
      const away = topLeftOf(gmFrames, hiddenTokenId);
      if (!away) throw new Error('no position for the hidden goblin after the move');
      // The key handler moves from the rendered position, so wait for the re-render first.
      await expect(goblin).toHaveCSS('left', `${away.x}px`);
      await expect(goblin).toHaveCSS('top', `${away.y}px`);
      await goblin.press(back);
      // Moves snap to the grid, so an off-grid imported token comes back to its cell's corner.
      await expect.poll(() => topLeftOf(gmFrames, hiddenTokenId)).not.toEqual(away);
      moved = `${JSON.stringify(start)} -${go}-> ${JSON.stringify(away)} -${back}-> ${JSON.stringify(topLeftOf(gmFrames, hiddenTokenId))}`;
      break;
    }
    if (!moved) throw new Error('the GM could not move the hidden goblin');
    await gm.waitForTimeout(RT12_QUIET_MS);
    const after = Object.fromEntries(Object.entries(watched).map(([who, frames]) => [who, stateFrames(frames)]));
    const extra = Object.entries(watched)
      .filter(([who]) => after[who] !== before[who])
      .map(([who, frames]) => {
        const late = frames.filter((f) => f.tag === 'StateSnapshot' || f.tag === 'CommandAccepted').slice(before[who]);
        const kinds = late.map((f) => `${f.tag}#${String(f.payload.seq_id)}[${((f.payload.events ?? []) as Array<{ event?: string }>).map((e) => e.event).join(',')}]`);
        return `${who}: ${kinds.join(' ')}`;
      });
    if (extra.length) throw new Error(`state frames reached players during the hidden moves: ${extra.join('; ')}`);
    for (const preset of ['DAYLIGHT', 'NIGHT_MOONLIGHT']) {
      await gm.getByTestId('gm-lighting').selectOption(preset);
      for (const [who, frames] of Object.entries(watched)) {
        await expect.poll(() => latestState(frames)?.ambient_lighting, { message: `${who} sees ${preset}` }).toBe(preset);
      }
    }
    const control = Object.entries(watched).map(([who, frames]) => `${who} +${stateFrames(frames) - after[who]}`);
    return `GM moved the hidden goblin (${moved}): 0 state frames to any player in ${RT12_QUIET_MS} ms; lighting change and back: ${control.join(', ')}`;
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

  await phase("Doors: the player's TOGGLE_DOOR from afar is refused (DoorOutOfReach); from 5 ft away it opens and closes the door", async () => {
    const crypt = wallsOf(plFrames).find((w) => w.kind?.kind === 'DOOR' && !w.kind.is_locked);
    if (!crypt) throw new Error('the player has no unlocked door');
    const playerSeesOpen = () => wallsOf(plFrames).find((w) => w.id === crypt.id)?.kind?.is_open;
    const start = topLeftOf(plFrames, pcTokenId);
    if (!start) throw new Error('no PC position');
    const handle = pl.getByTestId(`door-${crypt.id}`);
    const refusal = pl.getByTestId('command-feedback-item').filter({ hasText: /within 5 ft of the door/ });
    const refusalsBefore = await refusal.count();
    await handle.click();
    await expect(refusal).toHaveCount(refusalsBefore + 1);
    const toast = (await refusal.last().innerText()).replace(/\s+/g, ' ').trim();
    expect(playerSeesOpen(), 'the refused toggle left the door closed').toBe(false);
    await shot(both, 'door-out-of-reach');
    const token = pl.getByTestId(`token-${pcTokenId}`);
    const cell = Number(latestState(plFrames)?.cell_size_px ?? 70);
    await token.click();
    await pl.getByTestId('table-board').click({ position: { x: DOOR_REACH_CELL.x + cell / 2, y: DOOR_REACH_CELL.y + cell / 2 } });
    await expect.poll(() => topLeftOf(plFrames, pcTokenId)).toEqual(DOOR_REACH_CELL);
    await handle.click();
    await expect.poll(playerSeesOpen).toBe(true);
    await expect(handle).toHaveAttribute('aria-pressed', 'true');
    await shot(both, 'door-opened-by-player');
    await handle.click();
    await expect.poll(playerSeesOpen).toBe(false);
    await token.click();
    await pl.getByTestId('table-board').click({ position: { x: start.x + cell / 2, y: start.y + cell / 2 } });
    await expect.poll(() => topLeftOf(plFrames, pcTokenId)).toEqual(start);
    return `refusal toast: "${toast}"; opened and closed from ${JSON.stringify(DOOR_REACH_CELL)}, PC back at ${JSON.stringify(start)}`;
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

  /** The player never received a d20 or total of a roll against `tokenId` (ADR-0042 privacy). */
  const assertNoRollsAgainst = (tokenId: string) => {
    for (const resolution of resolutionsSeen(plFrames)) {
      for (const target of resolution.targets.filter((t) => t.token_id === tokenId)) {
        expect({ d20: target.d20_rolls, total: target.total }, `${resolution.action_name}: no roll against the monster reached the player`).toEqual({
          d20: [],
          total: null,
        });
      }
    }
  };

  let srdTokenId = '';
  const srdHp = () => Number(latestState(gmFrames)?.tokens[srdTokenId]?.hp);
  const pcHp = () => Number(latestState(gmFrames)?.tokens[pcTokenId]?.hp);

  /**
   * The player rolls their first sheet attack at the SRD monster until the
   * server reports a hit (a miss is stored as applied, never pending), checking
   * on every roll that the outcome arrives without d20 or total. Leaves the
   * card open on the hit.
   */
  const playerAttacksUntilHit = async () => {
    const outcomes: string[] = [];
    for (let attempt = 1; attempt <= MAX_ATTACK_ATTEMPTS; attempt++) {
      await openSheetFor(pl, pcTokenId);
      const resolve = pl.locator('[data-testid^="btn-atk-resolve-"]:enabled');
      await revealInSheet(pl, resolve);
      const attack = (await resolve.first().getAttribute('aria-label')) ?? '';
      await resolve.first().click();
      const card = pl.getByTestId('action-card');
      await expect(card).toBeVisible();
      await pl.getByTestId(`action-target-${srdTokenId}`).check();
      await pl.getByTestId('action-roll').click();
      const result = pl.getByTestId(`action-result-${srdTokenId}`);
      await expect(result).toBeVisible();
      const outcome = (await pl.getByTestId(`action-outcome-${srdTokenId}`).innerText()).trim();
      expect(outcome).toMatch(/^(Hit|Critical hit|Miss)$/);
      expect(await result.innerText(), 'no d20 or total against the hidden AC').not.toMatch(/rolled|d20/);
      outcomes.push(outcome);
      if (outcome !== 'Miss') {
        const resolution = lastResolution(plFrames);
        if (!resolution?.targets.some((t) => t.token_id === srdTokenId)) throw new Error('no ACTION_RESOLVED for the monster reached the player');
        const damage = Number(/(\d+) damage/.exec(await pl.getByTestId(`action-damage-${srdTokenId}`).innerText())?.[1]);
        return { attack, outcome, damage, resolutionId: resolution.id, outcomes };
      }
      await expect(pl.getByTestId('action-nothing-left'), 'a miss leaves nothing to apply').toBeVisible();
      await pl.getByTestId('action-cancel').click();
      await expect(card).toBeHidden();
    }
    throw new Error(`no hit in ${MAX_ATTACK_ATTEMPTS} attacks (${outcomes.join(', ')})`);
  };

  await phase('GM spawns an SRD monster at the selected cell, hidden from players; the server fills HP and AC; the GM reveals it and the player sees a tier only', async () => {
    const pc = topLeftOf(gmFrames, pcTokenId);
    if (!pc) throw new Error('no PC position');
    const cell = Number(latestState(gmFrames)?.cell_size_px ?? 70);
    const taken = Object.values(latestState(gmFrames)?.tokens ?? {}).map((t) => t.top_left as { x: number; y: number });
    const at = [
      [1, 0],
      [0, 1],
      [0, -1],
      [-1, 0],
      [1, 1],
      [1, -1],
    ]
      .map(([dx, dy]) => ({ x: pc.x + dx * cell, y: pc.y + dy * cell }))
      .find((p) => p.x >= 0 && p.y >= 0 && p.x + cell <= 700 && p.y + cell <= 540 && !taken.some((t) => t.x === p.x && t.y === p.y));
    if (!at) throw new Error(`no free cell next to the PC at ${JSON.stringify(pc)}`);
    await gm.getByTestId(`token-${pcTokenId}`).press('Escape');
    await gm.getByTestId('table-board').click({ position: { x: at.x + cell / 2, y: at.y + cell / 2 } });
    await expect(gm.getByTestId('table-selected-cell')).toContainText(`column ${at.x / cell + 1}, row ${at.y / cell + 1}`);
    await openTab(gm, 'compendium');
    await gm.getByTestId('compendium-tab-monster').click();
    await gm.getByTestId('compendium-search-input').fill(SRD_MONSTER.name);
    await gm.getByTestId(`btn-stat-block-${SRD_MONSTER.slug}`).click();
    await expect(gm.getByTestId(`stat-block-${SRD_MONSTER.slug}`)).toBeVisible();
    await shot({ gm }, 'gm-compendium-monster');
    await gm.getByTestId(`btn-spawn-${SRD_MONSTER.slug}`).click();
    await expect(gm.getByTestId('workspace-spawn-status')).toContainText(`${SRD_MONSTER.name} spawned on the table, hidden from players`);
    const spawned = () => Object.values(latestState(gmFrames)?.tokens ?? {}).find((t) => String(t.name).startsWith(SRD_MONSTER.name));
    await expect.poll(() => spawned()?.id ?? null).not.toBeNull();
    const token = spawned()!;
    srdTokenId = String(token.id);
    expect({ hp: token.hp, max: token.max_hp, ac: token.ac }, 'server-derived vitals from the SRD stat block').toEqual({
      hp: SRD_MONSTER.hp,
      max: SRD_MONSTER.hp,
      ac: SRD_MONSTER.ac,
    });
    expect(token.top_left, 'spawned at the selected cell').toEqual(at);
    expect(token.stat_block, 'the GM token carries the server copy of the stat block').toBeTruthy();
    await openTab(gm, 'table');
    const gmToken = gm.getByTestId(`token-${srdTokenId}`);
    await expect(gmToken).toHaveAttribute('aria-label', /hidden from players/);
    await expect(pl.getByTestId(`token-${srdTokenId}`)).toHaveCount(0);
    expect(JSON.stringify(plFrames), 'the hidden monster never reached the player').not.toContain(srdTokenId);
    await shot(both, 'srd-monster-hidden');
    await gmToken.click({ button: 'right' });
    await expect(gm.getByTestId('token-menu-visibility')).toHaveText('Reveal to players');
    await gm.getByTestId('token-menu-visibility').click();
    await expect(gm.getByTestId('token-menu')).toBeHidden();
    await expect(gmToken).not.toHaveAttribute('aria-label', /hidden from players/);
    await gmToken.click();
    await expect(gm.getByTestId('vitals-hp')).toContainText(`HP ${SRD_MONSTER.hp} / ${SRD_MONSTER.hp}`);
    const plToken = pl.getByTestId(`token-${srdTokenId}`);
    await expect(plToken).toHaveAttribute('aria-label', /Unhurt/);
    await plToken.click();
    await expect(pl.getByTestId('vitals-hp')).toHaveText('Unhurt');
    assertPublicOnly(srdTokenId);
    await shot(both, 'srd-monster-revealed');
    return `${token.name} at ${JSON.stringify(token.top_left)} (PC at ${JSON.stringify(pc)}): HP ${token.hp}/${token.max_hp}, AC ${token.ac}`;
  });

  await phase('Player attacks the SRD monster: the server rolls against the hidden AC; the GM sees the pending hit and a double Apply damages it once', async () => {
    const hit = await playerAttacksUntilHit();
    const entry = gm.getByTestId(`pending-${hit.resolutionId}`);
    await expect(entry).toBeVisible();
    await expect(gm.getByTestId('pending-resolutions-count')).toContainText('Pending resolutions:');
    await expect(gm.getByTestId(`pending-${hit.resolutionId}-outcome-${srdTokenId}`)).toHaveText(hit.outcome);
    await expect(gm.getByTestId(`pending-${hit.resolutionId}-result-${srdTokenId}`), 'the GM sees the attack roll').toContainText('rolled');
    await expect(gm.getByTestId(`pending-${hit.resolutionId}-damage-${srdTokenId}`)).toHaveValue(String(hit.damage));
    await shot(both, 'player-attack-pending');
    const before = srdHp();
    await doubleApplyOnce(gm, gmFrames, gmSent, hit.resolutionId, hit.damage, srdHp);
    await expect(pl.getByTestId('action-nothing-left'), "the player's card shows the GM's Apply").toBeVisible();
    await expect(pl.getByTestId('action-apply')).toBeDisabled();
    await expect(pl.getByTestId('action-status')).toHaveText(`${SRD_MONSTER.name}: ${hit.outcome}`);
    await shot(both, 'player-attack-applied');
    await pl.getByTestId('action-cancel').click();
    await expect(pl.getByTestId('action-card')).toBeHidden();
    const tier = tierFor(before - hit.damage, SRD_MONSTER.hp);
    await expect(pl.getByTestId(`token-${srdTokenId}`)).toHaveAttribute('aria-label', tier);
    await pl.getByTestId(`token-${srdTokenId}`).click();
    await expect(pl.getByTestId('vitals-hp')).toHaveText(tier);
    await gm.getByTestId(`token-${srdTokenId}`).click();
    await expect(gm.getByTestId('vitals-hp')).toContainText(`HP ${before - hit.damage} /`);
    assertPublicOnly(srdTokenId);
    assertNoRollsAgainst(srdTokenId);
    return `${hit.attack}: ${hit.outcomes.join(' -> ')}; ${hit.damage} damage applied once by the GM's double Apply; HP ${before} -> ${before - hit.damage}`;
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

  await phase('Player casts Burning Hands at the SRD monster: the server rolls its DEX save; the GM sees it pending; the player Applies', async () => {
    const before = srdHp();
    await openSheetFor(pl, pcTokenId);
    const cast = pl.getByTestId('btn-cast-spell-srd:spell:burning_hands');
    await revealInSheet(pl, cast);
    const saved = pl.waitForResponse((r) => r.url().includes(`/actors/${pcActorId}`) && r.request().method() === 'PUT');
    await cast.click();
    expect((await saved).status(), 'the player spends their last level-1 slot').toBe(200);
    const card = pl.getByTestId('action-card');
    await expect(card).toBeVisible();
    await pl.getByTestId('action-area-token').selectOption(srdTokenId);
    await pl.getByTestId('action-area-project').click();
    const result = pl.getByTestId(`action-result-${srdTokenId}`);
    await expect(result).toBeVisible({ timeout: 15_000 });
    const outcome = (await pl.getByTestId(`action-outcome-${srdTokenId}`).innerText()).trim();
    expect(outcome, 'the server rolled the save').toMatch(/^Save (succeeded|failed)$/);
    expect(await result.innerText(), "no save roll of the monster for the player").not.toMatch(/rolled|d20/);
    const damage = Number(/(\d+) damage/.exec(await pl.getByTestId(`action-damage-${srdTokenId}`).innerText())?.[1]);
    expect(damage, 'Burning Hands deals at least half of 3d6').toBeGreaterThan(0);
    const resolution = lastResolution(plFrames);
    if (!resolution?.targets.some((t) => t.token_id === srdTokenId)) throw new Error('no ACTION_RESOLVED for the monster reached the player');
    expect(resolution.targets.map((t) => t.token_id), 'the cone never burns its caster').not.toContain(pcTokenId);
    const others = resolution.targets.filter((t) => t.token_id !== srdTokenId).length;
    const entry = gm.getByTestId(`pending-${resolution.id}`);
    await expect(entry).toBeVisible();
    await expect(gm.getByTestId(`pending-${resolution.id}-outcome-${srdTokenId}`)).toHaveText(outcome);
    await expect(gm.getByTestId(`pending-${resolution.id}-result-${srdTokenId}`), 'the GM sees the save roll').toContainText('rolled');
    await shot(both, 'player-area-pending');
    await pl.getByTestId('action-apply').click();
    await expect(card).toBeHidden();
    await expect.poll(srdHp).toBe(before - damage);
    await expect(entry).toHaveCount(0);
    await expect(pl.getByTestId(`token-${srdTokenId}`)).toHaveAttribute('aria-label', tierFor(before - damage, SRD_MONSTER.hp));
    assertPublicOnly(srdTokenId);
    assertNoRollsAgainst(srdTokenId);
    await shot(both, 'player-area-applied');
    return `${outcome}: ${damage} fire damage applied by the player; monster HP ${before} -> ${before - damage}; ${others} other token(s) in the cone`;
  });

  /** Damage the GM applies to the concentrating Wizard (kept low so a level-1 PC stays up). */
  const PISTOL_APPLIED = 1;
  await phase("GM attacks the concentrating Wizard with the SRD monster's Pistol from the stat block panel and Applies an adjusted hit", async () => {
    await pl.getByTestId(`token-${pcTokenId}`).click();
    const concentrate = pl.getByTestId('vitals-concentration');
    await expect(concentrate).toHaveText('Start concentrating');
    await concentrate.click();
    await expect.poll(() => latestState(gmFrames)?.tokens[pcTokenId]?.concentrating).toBe(true);
    await expect(concentrate).toHaveText('End concentration');
    const before = pcHp();
    const outcomes: string[] = [];
    for (let attempt = 1; attempt <= MAX_ATTACK_ATTEMPTS; attempt++) {
      await gm.getByTestId(`token-${srdTokenId}`).click();
      await expect(gm.getByTestId('monster-turn')).toBeVisible();
      await gm.getByTestId('monster-turn-action-pistol').click();
      const card = gm.getByTestId('action-card');
      await expect(card).toBeVisible();
      await gm.getByTestId(`action-target-${pcTokenId}`).check();
      await gm.getByTestId('action-roll').click();
      const result = gm.getByTestId(`action-result-${pcTokenId}`);
      await expect(result).toBeVisible();
      await expect(result, 'the GM sees the attack roll').toContainText('rolled');
      const outcome = (await gm.getByTestId(`action-outcome-${pcTokenId}`).innerText()).trim();
      outcomes.push(outcome);
      if (outcome === 'Miss') {
        await gm.getByTestId('action-cancel').click();
        await expect(card).toBeHidden();
        continue;
      }
      const amount = gm.getByTestId(`action-damage-${pcTokenId}`);
      const rolled = Number(await amount.inputValue());
      await amount.fill(String(PISTOL_APPLIED));
      await shot(both, 'gm-pistol-review');
      await gm.getByTestId('action-apply').click();
      await expect(card).toBeHidden();
      await expect.poll(pcHp).toBe(before - PISTOL_APPLIED);
      return `Pistol: ${outcomes.join(' -> ')}; rolled ${rolled} damage, the GM applied ${PISTOL_APPLIED}; PC HP ${before} -> ${before - PISTOL_APPLIED}`;
    }
    throw new Error(`no Pistol hit in ${MAX_ATTACK_ATTEMPTS} attacks (${outcomes.join(', ')})`);
  });

  await phase("Concentration check: the player rolls the damaged Wizard's CON save on the server; the result stays until dismissed", async () => {
    const check = pl.getByTestId(`concentration-check-${pcTokenId}`);
    await expect(check).toContainText(`${PC_NAME}: CON save DC 10`);
    await expect(gm.getByTestId(`concentration-check-${pcTokenId}`), 'the GM sees the open check').toBeVisible();
    await pl.getByTestId(`concentration-roll-${pcTokenId}`).click();
    const result = pl.getByTestId('concentration-result');
    await expect(result).toHaveText(new RegExp(`^${PC_NAME} (keeps|loses) concentration \\(\\d+ vs DC 10\\)\\.$`));
    await expect(check).toHaveCount(0);
    const text = (await result.innerText()).trim();
    const kept = text.includes('keeps');
    await expect.poll(() => Boolean(latestState(plFrames)?.tokens[pcTokenId]?.concentrating)).toBe(kept);
    await shot(both, 'concentration-result');
    await gm.getByTestId(`token-${pcTokenId}`).click();
    const hp = hpOf(await gm.getByTestId('vitals-hp').innerText());
    await gm.getByTestId('vitals-amount').fill(String(PISTOL_APPLIED));
    await gm.getByTestId('vitals-heal').click();
    await expect(gm.getByTestId('vitals-hp')).toContainText(`HP ${hp.hp + PISTOL_APPLIED} /`);
    await expect(result, 'a later table event keeps the result').toHaveText(text);
    await pl.getByTestId('concentration-dismiss').click();
    await expect(pl.getByTestId('concentration-prompt')).toHaveCount(0);
    if (kept) {
      await pl.getByTestId(`token-${pcTokenId}`).click();
      await pl.getByTestId('vitals-concentration').click();
      await expect.poll(() => Boolean(latestState(plFrames)?.tokens[pcTokenId]?.concentrating)).toBe(false);
    }
    return `${text} Kept after the GM healed the ${PISTOL_APPLIED} damage, gone after Dismiss`;
  });

  await phase("Privacy: the player's page and socket never carry the SRD monster's AC, stat block or rolls against it", async () => {
    await gm.getByTestId(`token-${srdTokenId}`).click();
    await expect(gm.getByTestId('monster-turn'), 'the GM has the stat block').toContainText('Armor Class');
    await pl.getByTestId(`token-${srdTokenId}`).click();
    await expect(pl.getByTestId('vitals-hp')).toHaveText(/^(Unhurt|Bloodied|Down)$/);
    await expect(pl.getByTestId('vitals-stat-block')).toHaveCount(0);
    await expect(pl.locator('[data-testid^="monster-turn"]')).toHaveCount(0);
    await expect(pl.locator('[data-testid^="stat-block-"]')).toHaveCount(0);
    expect(await pl.getByTestId('vitals-panel').innerText(), 'no AC or HP numbers for the monster').not.toMatch(/\bAC\b|Armor Class|\d+ \/ \d+/);
    const page = await pl.locator('body').innerText();
    const wire = JSON.stringify(plFrames);
    for (const secret of ['Armor Class', "Captain's Charm", 'Riposte', '13d8 + 26']) {
      expect(page, `player page shows "${secret}"`).not.toContain(secret);
      expect(wire, `player socket carried "${secret}"`).not.toContain(secret);
    }
    assertPublicOnly(srdTokenId);
    assertNoRollsAgainst(srdTokenId);
    await shot(both, 'monster-privacy');
    return `player checked ${plFrames.length} frames and the page text; ${resolutionsSeen(plFrames).length} resolution copies without rolls against the monster`;
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

  /** What the table must show after the SIGKILL (invariant 7), filled by the two phases before it. */
  const crash = { pcHp: 0, pcMaxHp: 0, srdHp: 0, pendingResolutionId: '', pendingDamage: 0 };
  await phase('Player attacks the SRD monster again and leaves the server-held hit unapplied for the crash', async () => {
    const hit = await playerAttacksUntilHit();
    await pl.getByTestId('action-cancel').click();
    await expect(pl.getByTestId('action-card')).toBeHidden();
    await expect(pl.getByTestId(`pending-${hit.resolutionId}`), "the closed hit stays in the player's pending list").toBeVisible();
    await expect(gm.getByTestId(`pending-${hit.resolutionId}-damage-${srdTokenId}`)).toHaveValue(String(hit.damage));
    Object.assign(crash, { srdHp: srdHp(), pendingResolutionId: hit.resolutionId, pendingDamage: hit.damage });
    await shot(both, 'pending-before-crash');
    return `${hit.attack}: ${hit.outcomes.join(' -> ')}; ${hit.damage} damage pending on HP ${crash.srdHp}`;
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
    Object.assign(crash, { pcHp: start.hp, pcMaxHp: start.max });
    await shot(both, 'pre-crash-undone');
    return `PC ${start.hp} -> ${start.hp - 5} -> undo -> ${start.hp}`;
  });

  type Who = keyof typeof frameLogs;
  /** Frame count of every page, so checks after a harness action only read the reconnected sockets' frames. */
  const frameMarks = () => Object.fromEntries(Object.entries(frameLogs).map(([who, frames]) => [who, frames.length])) as Record<Who, number>;
  /** Waits until every page resynced after `marks` and the recorded pages show an open connection. */
  const allReconnected = async (marks: Record<Who, number>) => {
    for (const [who, frames] of Object.entries(frameLogs)) await snapshotAfter(frames, marks[who as Who]);
    for (const page of [gm, pl]) {
      await expect(page.getByTestId('connection-banner')).toHaveAttribute('data-state', 'open', { timeout: RECONNECT_TIMEOUT_MS });
    }
  };
  /** Reloads `page` and reopens the campaign's live table (the session cookie survives restarts). */
  const reopenTable = async (page: Page) => {
    await page.reload();
    const open = page.getByTestId(`lobby-open-${campaignId}`);
    await expect(page.getByTestId('campaign-workspace').or(open)).toBeVisible({ timeout: 30_000 });
    if (await open.isVisible()) await open.click();
    await expect(page.getByTestId('campaign-workspace')).toBeVisible();
    await openTab(page, 'table');
    await expect(page.getByTestId('table-map')).toBeVisible();
  };

  let crashMarks = frameMarks();
  await phase('Server is SIGKILLed mid-session and restarts on the same database; all four browsers reconnect on their own', async () => {
    crashMarks = frameMarks();
    const done = await harness(ARTIFACTS, 'sigkill');
    await allReconnected(crashMarks);
    await shot(both, 'after-sigkill-reconnected');
    return `${done}; every page resynced from a fresh StateSnapshot`;
  });

  await phase("GM's first snapshot after the SIGKILL shows the undone HP (no ghost damage)", async () => {
    const recovered = await snapshotAfter(gmFrames, crashMarks.gm);
    expect(recovered.tokens[pcTokenId]?.hp, 'WAL-recovered PC HP').toBe(crash.pcHp);
    await gm.getByTestId(`token-${pcTokenId}`).click();
    await expect(gm.getByTestId('vitals-hp')).toContainText(`HP ${crash.pcHp} / ${crash.pcMaxHp}`);
    const quarantine = gm.getByTestId('wal-quarantine-banner');
    if ((await quarantine.count()) > 0 && (await quarantine.evaluate((el) => el.classList.contains('ds-connection-banner')))) {
      note(`GM quarantine banner after recovery: ${(await quarantine.innerText()).replace(/\s+/g, ' ')}`);
    }
    await shot({ gm }, 'after-restart-gm');
    return `PC token hp ${crash.pcHp}/${crash.pcMaxHp} after WAL recovery`;
  });

  await phase("Player's first snapshot after the SIGKILL shows the same exact own HP", async () => {
    const recovered = await snapshotAfter(plFrames, crashMarks.player);
    expect(recovered.tokens[pcTokenId]?.hp, 'own PC HP in the recovered player projection').toBe(crash.pcHp);
    await pl.getByTestId(`token-${pcTokenId}`).click();
    await expect(pl.getByTestId('vitals-hp')).toContainText(`HP ${crash.pcHp} / ${crash.pcMaxHp}`);
    await shot({ player: pl }, 'after-restart-player');
  });

  const pending = () => `pending-${crash.pendingResolutionId}`;
  await phase('Player still sees the hit they left unapplied before the SIGKILL, with the same server-rolled damage', async () => {
    expect(crash.pendingResolutionId, 'the journey left a pending hit').not.toBe('');
    const recovered = await snapshotAfter(plFrames, crashMarks.player);
    expect(Object.keys((recovered.pending_resolutions ?? {}) as Record<string, unknown>), 'the recovered player projection carries the hit').toContain(
      crash.pendingResolutionId,
    );
    await expect(pl.getByTestId(pending())).toBeVisible();
    await expect(pl.getByTestId(`${pending()}-outcome-${srdTokenId}`)).toHaveText(/^(Hit|Critical hit)$/);
    await expect(pl.getByTestId(`${pending()}-damage-${srdTokenId}`)).toHaveText(`${crash.pendingDamage} damage`);
    await shot({ player: pl }, 'after-restart-player-pending');
  });

  await phase('The pending resolution survived the SIGKILL: the GM applies it exactly once', async () => {
    const recovered = await snapshotAfter(gmFrames, crashMarks.gm);
    expect(Number(recovered.tokens[srdTokenId]?.hp), 'the monster HP survived without the pending damage').toBe(crash.srdHp);
    await expect(gm.getByTestId(`${pending()}-damage-${srdTokenId}`)).toHaveValue(String(crash.pendingDamage));
    await doubleApplyOnce(gm, gmFrames, gmSent, crash.pendingResolutionId, crash.pendingDamage, srdHp);
    await expect(pl.getByTestId(pending())).toHaveCount(0);
    await shot(both, 'after-restart-pending-applied');
    return `monster HP ${crash.srdHp} -> ${crash.srdHp - crash.pendingDamage} after one Apply of ${crash.pendingDamage}`;
  });

  await phase('Server restarts gracefully mid-session (SIGTERM); all four browsers reconnect on their own and the table is unchanged', async () => {
    await gm.getByTestId('gm-lighting').selectOption('DAYLIGHT');
    await expect.poll(() => latestState(plFrames)?.ambient_lighting).toBe('DAYLIGHT');
    const before = { monster: srdHp(), pc: pcHp() };
    const marks = frameMarks();
    const done = await harness(ARTIFACTS, 'restart');
    await allReconnected(marks);
    const after = await snapshotAfter(gmFrames, marks.gm);
    expect({ monster: Number(after.tokens[srdTokenId]?.hp), pc: Number(after.tokens[pcTokenId]?.hp), lighting: after.ambient_lighting }).toEqual({
      ...before,
      lighting: 'DAYLIGHT',
    });
    await shot(both, 'after-graceful-restart');
    return `${done}; monster HP ${before.monster}, PC HP ${before.pc} kept`;
  });

  await phase('Map images survive the restart: the player reloads and the background comes again from Silo (307, then 200 with CORS) and is drawn', async () => {
    const mark = plImages.length;
    await cdp.player.clearCache();
    await reopenTable(pl);
    const fetch = await expectS3Image(plImages, mark);
    const green = await greenOf(pl, PROBE.west);
    await shot({ player: pl }, 'after-restart-map-from-s3');
    expect(green, 'the green S3 background is drawn on the player canvas (mean G - R)').toBeGreaterThan(BACKGROUND_GREEN_MIN);
    return `${fetch.redirectStatus} -> ${fetch.status} ACAO ${fetch.allowOrigin}; player west G-R ${green}`;
  });

  await phase('Harness backs up the database mid-session with the backup image (pg_dump)', async () => {
    return harness(ARTIFACTS, 'backup');
  });

  const AFTER_BACKUP_NOTE = 'Written after the backup';
  await phase('GM writes a GM-only note after the backup', async () => {
    await openTab(gm, 'documents');
    await gm.getByTestId('create-note-btn').click();
    await gm.getByTestId('note-title-input').fill(AFTER_BACKUP_NOTE);
    await gm.getByTestId('note-scope-select').selectOption('DM_ONLY');
    await gm.getByTestId('note-content-editor').fill('This note must not survive the restore.');
    const saved = gm.waitForResponse((r) => r.url().includes('/notes/') && r.request().method() === 'PUT');
    await gm.getByTestId('save-note-btn').click();
    expect((await saved).status()).toBeLessThan(300);
    expect(await (await gm.request.get(campaignApi('/notes'))).text()).toContain(AFTER_BACKUP_NOTE);
    await openTab(gm, 'table');
  });

  await phase('Harness wipes the database volume and restores the dump; the server restarts and all four browsers reconnect on their own', async () => {
    const table = (state: ProjectedState | null) => ({
      monster: Number(state?.tokens[srdTokenId]?.hp),
      pc: Number(state?.tokens[pcTokenId]?.hp),
      mapWidthPx: state?.map_width_px,
      walls: state?.walls.length,
    });
    const before = table(latestState(gmFrames));
    const marks = frameMarks();
    const done = await harness(ARTIFACTS, 'restore');
    await allReconnected(marks);
    expect(table(await snapshotAfter(gmFrames, marks.gm)), 'restored table: scene, walls and hit points').toEqual(before);
    await shot(both, 'after-restore-reconnected');
    return `${done}; monster HP ${before.monster}, PC HP ${before.pc} restored`;
  });

  await phase('After the restore the campaign, its notes and the map are back, the note written after the backup is gone, and both canvases draw the map from Silo', async () => {
    const campaigns = await (await gm.request.get('/api/v1/campaigns')).text();
    expect(campaigns, 'the campaign is restored').toContain(CAMPAIGN);
    const notes = await (await gm.request.get(campaignApi('/notes'))).text();
    expect(notes, 'notes written before the backup are restored').toContain('Crypt Lore');
    expect(notes, 'the note written after the backup is gone').not.toContain(AFTER_BACKUP_NOTE);
    const fetched: string[] = [];
    const green: Record<string, number> = {};
    for (const [who, page, images, probe] of [
      ['gm', gm, gmImages, cdp.gm],
      ['player', pl, plImages, cdp.player],
    ] as const) {
      const mark = images.length;
      await probe.clearCache();
      await reopenTable(page);
      const fetch = await expectS3Image(images, mark);
      fetched.push(`${who} ${fetch.redirectStatus} -> ${fetch.status}`);
      green[who] = await greenOf(page, PROBE.west);
    }
    await shot(both, 'after-restore-map-from-s3');
    for (const [who, value] of Object.entries(green)) expect(value, `${who}: the restored map is drawn from Silo (mean G - R)`).toBeGreaterThan(BACKGROUND_GREEN_MIN);
    return `${fetched.join(', ')}; G-R ${JSON.stringify(green)}`;
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

  await phase('No CSP violations in any of the four browsers', async () => {
    expect(cspViolations).toEqual([]);
    return `${cspViolations.length} violations`;
  });

  await gm.waitForTimeout(1000);
  writeFileSync(join(ARTIFACTS, 'console.log'), consoleLog.join('\n'));
  writeFileSync(join(ARTIFACTS, 'csp-violations.log'), cspViolations.join('\n'));
  writeFileSync(join(ARTIFACTS, 'frames-player.json'), JSON.stringify(plFrames.map((f: RecordedFrame) => f.tag)));
  writeFileSync(join(ARTIFACTS, 'phases.json'), JSON.stringify({ results, notes }, null, 2));
  await p2Ctx.close();
  await p3Ctx.close();
  await gmCtx.close();
  await plCtx.close();
  await gm.video()?.saveAs(join(ARTIFACTS, 'gm.webm'));
  await pl.video()?.saveAs(join(ARTIFACTS, 'player.webm'));
  printPhases();
});
