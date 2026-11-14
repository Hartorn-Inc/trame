/**
 * ============================================================================
 * REST ACTION ERROR MESSAGES (api/errorMessages.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Translates the server's `{ code, error }` refusals of workspace actions
 * (sheet saves, character creation, dice, uploads, map imports) into
 * localized sentences that tell the user what to change. Without it those
 * screens printed the raw English server text, or nothing useful for a
 * throttled (`429`) or over-quota (`413`) upload.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Known Codes Only`:
 *    - `knownApiErrorMessage` returns `null` for anything it does not
 *      recognise, so each caller keeps its own fallback.
 * 2. `Role-Accurate Limits`:
 *    - `INVALID_IMAGE` names the pixel ceiling of the uploader's role:
 *      16 megapixels for players (`MAX_PLAYER_IMAGE_PIXEL_AREA`) and 64 for
 *      the Game Master (`MAX_IMAGE_PIXEL_AREA`).
 * 3. `Throttling By Status`:
 *    - Every `429` (per-user upload limit, auth limits) maps to the same
 *      "wait, then retry" sentence, whatever its code.
 * ============================================================================
 */
import { t, type MessageKey } from "../i18n/index.ts";
import { ApiError } from "./client.ts";

/** Pixel ceiling of a player image upload, in megapixels (`16 * 2^20` pixels). */
export const PLAYER_IMAGE_MEGAPIXELS = 16;
/** Pixel ceiling of a Game Master image upload or map import, in megapixels (`64 * 2^20` pixels). */
export const GM_IMAGE_MEGAPIXELS = 64;

const CODE_KEYS: Readonly<Record<string, MessageKey>> = {
  INVALID_ABILITY_SCORE: "apiError.invalidAbilityScore",
  INITIATIVE_ROLL_REQUIRES_ROOM: "apiError.initiativeRequiresRoom",
  STORAGE_QUOTA_EXCEEDED: "apiError.storageQuota",
  PAYLOAD_TOO_LARGE: "apiError.payloadTooLarge",
};

/** Options for `knownApiErrorMessage`. */
export interface ApiErrorMessageOptions {
  /** The caller is the campaign's Game Master (selects the image pixel ceiling). */
  isGm?: boolean;
}

/** Localized message for a recognised server refusal, or `null` (invariant 1). */
export function knownApiErrorMessage(err: unknown, options: ApiErrorMessageOptions = {}): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status === 429) return t("apiError.rateLimited");
  if (err.code === "INVALID_IMAGE") {
    return t("apiError.invalidImage", { megapixels: options.isGm ? GM_IMAGE_MEGAPIXELS : PLAYER_IMAGE_MEGAPIXELS });
  }
  const key = err.code ? CODE_KEYS[err.code] : undefined;
  return key ? t(key) : null;
}

/**
 * `knownApiErrorMessage`, else the error's own message, else `fallback`:
 * the message a workspace action shows when its request fails.
 */
export function describeActionError(err: unknown, fallback: string, options: ApiErrorMessageOptions = {}): string {
  return knownApiErrorMessage(err, options) ?? (err instanceof Error && err.message ? err.message : fallback);
}
