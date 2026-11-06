// Server refusal codes of workspace actions mapped to localized messages (api/errorMessages.ts).
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ApiError } from "../../src/api/client.ts";
import { describeActionError, knownApiErrorMessage } from "../../src/api/errorMessages.ts";
import { localeSignal, type LocaleCode } from "../../src/i18n/index.ts";

afterEach(() => {
  localeSignal.value = "en";
});

const apiError = (status: number, code: string) => new ApiError(status, code, code.toLowerCase(), { code, error: code.toLowerCase() });

describe("knownApiErrorMessage", () => {
  const cases: Array<{ id: string; err: unknown; isGm?: boolean; locale?: LocaleCode; expected: string | null }> = [
    {
      id: "actor save with an out-of-range ability score",
      err: apiError(400, "INVALID_ABILITY_SCORE"),
      expected: "Ability scores must be whole numbers from 1 to 30.",
    },
    {
      id: "REST initiative roll outside the live table",
      err: apiError(400, "INITIATIVE_ROLL_REQUIRES_ROOM"),
      expected: "Initiative is rolled at the live table. Open the campaign table and roll it there.",
    },
    {
      id: "upload over the campaign storage quota",
      err: apiError(413, "STORAGE_QUOTA_EXCEEDED"),
      expected: "This campaign's file storage is full. Ask the server administrator for more space.",
    },
    {
      id: "per-user upload rate limit (429) whatever its code",
      err: apiError(429, "RATE_LIMITED"),
      expected: "Too many requests in a short time. Wait a minute, then try again.",
    },
    {
      id: "player image above 16 megapixels",
      err: apiError(400, "INVALID_IMAGE"),
      expected: "This image could not be used. Upload a PNG, JPEG, or WebP image of at most 16 megapixels.",
    },
    {
      id: "GM image names the 64 megapixel ceiling",
      err: apiError(400, "INVALID_IMAGE"),
      isGm: true,
      expected: "This image could not be used. Upload a PNG, JPEG, or WebP image of at most 64 megapixels.",
    },
    {
      id: "French storage quota message",
      err: apiError(413, "STORAGE_QUOTA_EXCEEDED"),
      locale: "fr",
      expected: "Le stockage de fichiers de cette campagne est plein. Demandez plus d'espace à l'administrateur du serveur.",
    },
    {
      id: "French player image ceiling",
      err: apiError(400, "INVALID_IMAGE"),
      locale: "fr",
      expected: "Cette image est inutilisable. Envoyez une image PNG, JPEG ou WebP d'au plus 16 mégapixels.",
    },
    { id: "unknown code is left to the caller", err: apiError(500, "INTERNAL"), expected: null },
    { id: "non-API error is left to the caller", err: new Error("boom"), expected: null },
  ];
  for (const c of cases) {
    it(c.id, () => {
      localeSignal.value = c.locale ?? "en";
      assert.equal(knownApiErrorMessage(c.err, { isGm: c.isGm }), c.expected);
    });
  }
});

describe("describeActionError", () => {
  const cases: Array<{ id: string; err: unknown; expected: string }> = [
    { id: "known code wins over the raw server text", err: apiError(400, "INVALID_ABILITY_SCORE"), expected: "Ability scores must be whole numbers from 1 to 30." },
    { id: "unknown error keeps its own message", err: new Error("disk on fire"), expected: "disk on fire" },
    { id: "non-error value falls back", err: "nope", expected: "fallback" },
  ];
  for (const c of cases) {
    it(c.id, () => assert.equal(describeActionError(c.err, "fallback"), c.expected));
  }
});
