/**
 * ============================================================================
 * SESSION BOOTSTRAP & ENTRY ROUTE (api/bootstrap.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Decides, before the auth guard renders anything, who the user is and which
 * entry screen the URL asks for: the owner setup page (`/setup?token=`), the
 * password reset page (`/reset-password?token=`), an `InviteRedemption`
 * (`?invite=<token>`), or the normal app. If the guard ran
 * first, an invited visitor would land on a sign-in form they cannot use
 * (registration is closed) and the token would be lost.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Only Token Secrets Are Read From The URL`:
 *    - `?invite=` and, on `/setup` or `/reset-password`, `?token=` are read;
 *      identity never comes from the URL (G4). Parameters like `user_id` or
 *      `role` are ignored.
 * 2. `Secrets Leave The Address Bar Immediately`:
 *    - Every token is stripped (and `/setup` or `/reset-password` replaced by
 *      `/`) before any
 *      request, so they do not stay in history, screenshots or `Referer`.
 *      The route keeps the token in memory for its screen.
 * 3. `Session Restored First`:
 *    - `/auth/me` always runs, so the invite screen knows whether to offer
 *      "Join" (signed in) or the account form (signed out).
 * 4. `Fail Closed To Anonymous`:
 *    - A network failure on restore leaves the user `anonymous`.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `bootstrapSession(client, location, replaceUrl)`
 * ├── 1. `readBootRoute(location)` -> `setup` | `reset` | `invite` | `app`.
 * ├── 2. Not `app` -> `replaceUrl(stripBootSecrets(location))`.
 * ├── 3. `restoreSession()` (`GET /api/v1/auth/me`); failure -> `anonymous`.
 * └── 4. Return the route; `App` renders the matching screen.
 * ============================================================================
 */
import type { ApiClient } from "./client.ts";

/** Query parameter carrying a `CampaignInvite` token. */
export const INVITE_PARAM = "invite";
/** SPA path of the owner setup page (matches the server's `OWNER_SETUP_PATH`). */
export const SETUP_PATH = "/setup";
/** Query parameter carrying the owner setup token on `SETUP_PATH` and the reset token on `RESET_PATH`. */
export const SETUP_TOKEN_PARAM = "token";
/** SPA path of the password reset page (matches the server's `PASSWORD_RESET_PATH`). */
export const RESET_PATH = "/reset-password";

/** Entry pages whose only purpose is a URL token; they collapse to `/` once the token is read. */
const TOKEN_PAGES: readonly string[] = [SETUP_PATH, RESET_PATH];

/** Current page location fields read by the bootstrap. */
export interface BootLocation {
  pathname: string;
  search: string;
  hash: string;
}

/** Entry screen requested by the URL; tokens are raw strings (possibly empty for `setup`). */
export type BootRoute =
  | { kind: "app" }
  | { kind: "setup"; token: string }
  | { kind: "reset"; token: string }
  | { kind: "invite"; token: string };

/** The normal app route (lobby / workspace behind the auth guard). */
export const APP_ROUTE: BootRoute = { kind: "app" };

/** Reads the entry route; `/setup` and `/reset-password` win over `?invite=`. */
export function readBootRoute(location: BootLocation): BootRoute {
  const params = new URLSearchParams(location.search);
  const token = params.get(SETUP_TOKEN_PARAM)?.trim() ?? "";
  if (location.pathname === SETUP_PATH) return { kind: "setup", token };
  if (location.pathname === RESET_PATH) return { kind: "reset", token };
  const invite = params.get(INVITE_PARAM)?.trim();
  return invite ? { kind: "invite", token: invite } : APP_ROUTE;
}

/**
 * Returns `location` as a relative URL without the invite / setup / reset token;
 * `/setup` and `/reset-password` become `/` because they mean nothing without their token.
 */
export function stripBootSecrets(location: BootLocation): string {
  const params = new URLSearchParams(location.search);
  params.delete(INVITE_PARAM);
  const onTokenPage = TOKEN_PAGES.includes(location.pathname);
  if (onTokenPage) params.delete(SETUP_TOKEN_PARAM);
  const query = params.toString();
  return `${onTokenPage ? "/" : location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

/**
 * Strips URL secrets, restores the cookie session, and returns the entry
 * route. Always leaves `client.state.status` out of `restoring`.
 */
export async function bootstrapSession(
  client: ApiClient,
  location: BootLocation,
  replaceUrl: (url: string) => void,
): Promise<BootRoute> {
  const route = readBootRoute(location);
  if (route.kind !== "app") replaceUrl(stripBootSecrets(location));
  try {
    await client.restoreSession();
  } catch {
    client.state.user.value = null;
    client.state.status.value = "anonymous";
  }
  return route;
}
