/**
 * ============================================================================
 * SESSION BOOTSTRAP & GUEST SESSION UPGRADE (api/bootstrap.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Decides who the user is before the auth guard renders anything. An invite
 * link (`?invite=<jwt>`) must be redeemed FIRST: if the guard ran first, an
 * invited player without a session would land on the sign-in form and the
 * invite would be lost.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Invite Only Via ?invite=`:
 *    - No other query parameter (`token`, `user_id`, `role`) is read; identity
 *      never comes from the URL (G4).
 * 2. `Single-Use URL`:
 *    - The `invite` parameter is stripped from the address bar whether the
 *      redemption succeeds or fails, so a reload cannot replay a consumed or
 *      expired token.
 * 3. `Fail Open To Restore`:
 *    - A failed redemption records `inviteError` and falls through to the
 *      normal `/auth/me` restore, so an existing session still works.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `bootstrapSession(client, location, replaceUrl)`
 * ├── 1. `?invite=` present -> `redeemInvite` (GuestSessionUpgrade), strip it.
 * │      └── success -> authenticated, `activeCampaignId` set; done.
 * └── 2. Otherwise / on failure -> `restoreSession()` (`GET /api/v1/auth/me`).
 *        └── network failure -> `anonymous`.
 * ============================================================================
 */
import { ApiError, type ApiClient } from "./client.ts";

/** Query parameter carrying the invite JWT. */
export const INVITE_PARAM = "invite";

/** Current page location fields read by the bootstrap. */
export interface BootLocation {
  pathname: string;
  search: string;
  hash: string;
}

/** Returns `location` as a relative URL with the `invite` parameter removed. */
export function stripInviteParam(location: BootLocation): string {
  const params = new URLSearchParams(location.search);
  params.delete(INVITE_PARAM);
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

/**
 * Runs `GuestSessionUpgrade` when `?invite=` is present, otherwise restores
 * the cookie session. Always leaves `client.state.status` out of `restoring`.
 */
export async function bootstrapSession(
  client: ApiClient,
  location: BootLocation,
  replaceUrl: (url: string) => void,
): Promise<void> {
  const invite = new URLSearchParams(location.search).get(INVITE_PARAM);
  if (invite) {
    replaceUrl(stripInviteParam(location));
    try {
      await client.redeemInvite(invite);
      client.state.inviteError.value = null;
      return;
    } catch (err) {
      client.state.inviteError.value =
        err instanceof ApiError ? (err.code ?? err.message) : String(err);
    }
  }

  try {
    await client.restoreSession();
  } catch {
    client.state.user.value = null;
    client.state.status.value = "anonymous";
  }
}
