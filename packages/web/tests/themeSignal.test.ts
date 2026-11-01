import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import {
  getSystemPrefersDark,
  initThemeSignal,
  readPersistedThemeMode,
  resolvedThemeSignal,
  setThemeMode,
  syncThemeWithDom,
  systemPrefersDarkSignal,
  THEME_STORAGE_KEY,
  themeModeSignal,
  updateSystemThemePreference,
} from "../src/signals/themeSignal.ts";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../../..");
const tokensCssPath = path.join(repoRoot, "packages/web/src/styles/tokens.css");

// Lightweight DOM element stub for Node.js test environment
class MockDocumentElement {
  public attributes = new Map<string, string>();

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

// Lightweight localStorage stub for Node.js test environment
class MockLocalStorage {
  private store = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  public removeItem(key: string): void {
    this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }
}

// Lightweight matchMedia stub
class MockMediaQueryList {
  public matches: boolean;
  public media: string;
  private listeners: Array<(e: { matches: boolean }) => void> = [];

  constructor(media: string, matches: boolean) {
    this.media = media;
    this.matches = matches;
  }

  public addEventListener(event: string, handler: (e: { matches: boolean }) => void): void {
    if (event === "change") {
      this.listeners.push(handler);
    }
  }

  public removeEventListener(event: string, handler: (e: { matches: boolean }) => void): void {
    if (event === "change") {
      const idx = this.listeners.indexOf(handler);
      if (idx !== -1) {
        this.listeners.splice(idx, 1);
      }
    }
  }

  public dispatchChange(newMatches: boolean): void {
    this.matches = newMatches;
    for (const listener of this.listeners) {
      listener({ matches: newMatches });
    }
  }

  public get listenerCount(): number {
    return this.listeners.length;
  }
}

describe("ATLAS v1.1 Reactive Theme Signals & CSS Tokens (Ticket #104)", () => {
  let mockDocElement: MockDocumentElement;
  let mockStorage: MockLocalStorage;
  let activeMediaQuery: MockMediaQueryList;
  let originalWindow: unknown;
  let originalDocument: unknown;
  let originalLocalStorage: unknown;

  beforeEach(() => {
    originalWindow = (globalThis as Record<string, unknown>).window;
    originalDocument = (globalThis as Record<string, unknown>).document;
    originalLocalStorage = (globalThis as Record<string, unknown>).localStorage;

    mockDocElement = new MockDocumentElement();
    mockStorage = new MockLocalStorage();
    activeMediaQuery = new MockMediaQueryList("(prefers-color-scheme: dark)", true);

    (globalThis as Record<string, unknown>).document = {
      documentElement: mockDocElement,
    };

    (globalThis as Record<string, unknown>).localStorage = mockStorage;

    (globalThis as Record<string, unknown>).window = {
      matchMedia: (query: string) => {
        if (query.includes("dark")) {
          return activeMediaQuery;
        }
        return new MockMediaQueryList(query, !activeMediaQuery.matches);
      },
    };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).window = originalWindow;
    (globalThis as Record<string, unknown>).document = originalDocument;
    (globalThis as Record<string, unknown>).localStorage = originalLocalStorage;
  });

  describe("1. Acceptance Criteria — Reactive Theme Mode Switching", () => {
    it("WHEN themeModeSignal receives 'dark', resolvedThemeSignal evaluates to 'dark' and documentElement sets attribute data-theme='dark'", () => {
      // Toggle to light first to ensure state transition
      setThemeMode("light");
      assert.equal(themeModeSignal.value, "light");

      // Act: receive 'dark'
      themeModeSignal.value = "dark";

      // Assert criteria
      assert.equal(resolvedThemeSignal.value, "dark");
      assert.equal(mockDocElement.getAttribute("data-theme"), "dark");
      assert.equal(mockDocElement.getAttribute("data-resolved-theme"), "dark");
      assert.equal(mockStorage.getItem(THEME_STORAGE_KEY), "dark");
    });

    it("WHEN themeModeSignal receives 'light', resolvedThemeSignal evaluates to 'light' and documentElement sets attribute data-theme='light'", () => {
      // Toggle to dark first
      setThemeMode("dark");
      assert.equal(themeModeSignal.value, "dark");

      // Act: receive 'light'
      themeModeSignal.value = "light";

      // Assert criteria
      assert.equal(resolvedThemeSignal.value, "light");
      assert.equal(mockDocElement.getAttribute("data-theme"), "light");
      assert.equal(mockDocElement.getAttribute("data-resolved-theme"), "light");
      assert.equal(mockStorage.getItem(THEME_STORAGE_KEY), "light");
    });

    it("WHEN themeModeSignal receives 'system' and prefers-color-scheme matches 'dark', resolvedThemeSignal evaluates to 'dark'", () => {
      activeMediaQuery.matches = true;
      updateSystemThemePreference();

      // Act: receive 'system'
      themeModeSignal.value = "system";

      // Assert criteria
      assert.equal(resolvedThemeSignal.value, "dark");
      assert.equal(mockDocElement.getAttribute("data-theme"), "system");
      assert.equal(mockDocElement.getAttribute("data-resolved-theme"), "dark");
      assert.equal(mockStorage.getItem(THEME_STORAGE_KEY), "system");
    });

    it("WHEN themeModeSignal receives 'system' and prefers-color-scheme matches 'light', resolvedThemeSignal evaluates to 'light'", () => {
      activeMediaQuery.matches = false;
      updateSystemThemePreference();

      // Act: receive 'system'
      themeModeSignal.value = "system";

      // Assert criteria
      assert.equal(resolvedThemeSignal.value, "light");
      assert.equal(mockDocElement.getAttribute("data-theme"), "system");
      assert.equal(mockDocElement.getAttribute("data-resolved-theme"), "light");
      assert.equal(mockStorage.getItem(THEME_STORAGE_KEY), "system");
    });

    it("WHEN in 'system' mode and host OS dark mode changes dynamically, resolvedThemeSignal reacts and updates DOM", () => {
      activeMediaQuery.matches = true;
      const cleanup = initThemeSignal();

      setThemeMode("system");
      assert.equal(resolvedThemeSignal.value, "dark");
      assert.equal(mockDocElement.getAttribute("data-resolved-theme"), "dark");

      // Host OS changes preference to light
      activeMediaQuery.dispatchChange(false);

      assert.equal(resolvedThemeSignal.value, "light");
      assert.equal(mockDocElement.getAttribute("data-resolved-theme"), "light");

      // Teardown listener
      cleanup();
      assert.equal(activeMediaQuery.listenerCount, 0);
    });
  });

  describe("2. Storage Persistence & Initialization Fallbacks", () => {
    const storageTestCases = [
      { id: "persists_dark", input: "dark" as const, expected: "dark" as const },
      { id: "persists_light", input: "light" as const, expected: "light" as const },
      { id: "persists_system", input: "system" as const, expected: "system" as const },
    ];

    for (const tc of storageTestCases) {
      it(`[${tc.id}] persists '${tc.input}' to localStorage and reads back accurately`, () => {
        mockStorage.setItem(THEME_STORAGE_KEY, tc.input);
        const read = readPersistedThemeMode();
        assert.equal(read, tc.expected);
      });
    }

    it("falls back to 'dark' when localStorage holds unknown or invalid value", () => {
      mockStorage.setItem(THEME_STORAGE_KEY, "neon-cyberpunk");
      assert.equal(readPersistedThemeMode(), "dark");

      mockStorage.removeItem(THEME_STORAGE_KEY);
      assert.equal(readPersistedThemeMode(), "dark");
    });

    it("handles storage access exceptions safely without throwing (e.g. sandboxed iframe or private browsing)", () => {
      (globalThis as Record<string, unknown>).localStorage = {
        getItem: () => {
          throw new Error("SecurityError: Access denied");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      };

      assert.doesNotThrow(() => {
        const mode = readPersistedThemeMode();
        assert.equal(mode, "dark");
      });

      assert.doesNotThrow(() => {
        syncThemeWithDom();
      });
    });
  });

  describe("3. SSR / Node.js Headless Robustness (Zero Browser Globals)", () => {
    it("handles undefined window, document, and localStorage safely without throwing", () => {
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).document;
      delete (globalThis as Record<string, unknown>).localStorage;

      assert.doesNotThrow(() => {
        assert.equal(getSystemPrefersDark(), false);
        assert.equal(readPersistedThemeMode(), "dark");
        syncThemeWithDom();
        const cleanup = initThemeSignal();
        cleanup();
      });
    });
  });

  describe("4. tokens.css Local Fonts & Tabular-Nums Verification", () => {
    const cssContent = fs.readFileSync(tokensCssPath, "utf8");

    it("WHEN tokens.css loads, the stylesheet resolves font-family Space Grotesk and IBM Plex Sans from local URL paths without querying external font CDNs", () => {
      // Must not contain any external font CDN URL
      assert.doesNotMatch(cssContent, /fonts\.googleapis\.com/i);
      assert.doesNotMatch(cssContent, /fonts\.gstatic\.com/i);
      assert.doesNotMatch(cssContent, /https?:\/\//i);

      // Must declare @font-face for Space Grotesk (500, 600)
      assert.match(
        cssContent,
        /@font-face\s*\{[^}]*font-family:\s*"Space Grotesk"[^}]*font-weight:\s*500[^}]*src:\s*url\("\/fonts\/SpaceGrotesk-Medium\.woff2"\)/s,
      );
      assert.match(
        cssContent,
        /@font-face\s*\{[^}]*font-family:\s*"Space Grotesk"[^}]*font-weight:\s*600[^}]*src:\s*url\("\/fonts\/SpaceGrotesk-SemiBold\.woff2"\)/s,
      );

      // Must declare @font-face for IBM Plex Sans (400, 500, 600)
      assert.match(
        cssContent,
        /@font-face\s*\{[^}]*font-family:\s*"IBM Plex Sans"[^}]*font-weight:\s*400[^}]*src:\s*url\("\/fonts\/IBMPlexSans-Regular\.woff2"\)/s,
      );
      assert.match(
        cssContent,
        /@font-face\s*\{[^}]*font-family:\s*"IBM Plex Sans"[^}]*font-weight:\s*500[^}]*src:\s*url\("\/fonts\/IBMPlexSans-Medium\.woff2"\)/s,
      );
      assert.match(
        cssContent,
        /@font-face\s*\{[^}]*font-family:\s*"IBM Plex Sans"[^}]*font-weight:\s*600[^}]*src:\s*url\("\/fonts\/IBMPlexSans-SemiBold\.woff2"\)/s,
      );
    });

    it("verifies all 5 self-hosted WOFF2 font binary assets exist on disk with valid wOF2 magic headers", () => {
      const requiredFonts = [
        "SpaceGrotesk-Medium.woff2",
        "SpaceGrotesk-SemiBold.woff2",
        "IBMPlexSans-Regular.woff2",
        "IBMPlexSans-Medium.woff2",
        "IBMPlexSans-SemiBold.woff2",
      ];
      const fontsDir = path.join(repoRoot, "packages/web/public/fonts");
      for (const fontFile of requiredFonts) {
        const fp = path.join(fontsDir, fontFile);
        assert.ok(fs.existsSync(fp), `Font binary missing: ${fontFile}`);
        const header = fs.readFileSync(fp).subarray(0, 4).toString("ascii");
        assert.equal(header, "wOF2", `Invalid magic header for: ${fontFile}`);
      }
    });

    it("WHEN an element applies class .atlas-tabular-nums, the browser applies CSS property font-variant-numeric: tabular-nums", () => {
      assert.match(
        cssContent,
        /\.atlas-tabular-nums\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/s,
      );
    });

    it("WHEN an interactive element with class .ds-btn receives keyboard focus, the browser renders outline: 2px solid var(--atlas-focus) with outline-offset: 2px", () => {
      assert.match(
        cssContent,
        /\.ds-btn:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--atlas-focus\);[^}]*outline-offset:\s*2px;/s,
      );
      assert.match(
        cssContent,
        /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--atlas-focus\);[^}]*outline-offset:\s*2px;/s,
      );
    });

    it("enforces WCAG 2.1 AA accessibility guards: reduced-motion <= 0.01ms and disabled button opacity", () => {
      // Prefers-reduced-motion guard
      assert.match(
        cssContent,
        /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*animation-duration:\s*0\.01ms\s*!important;/s,
      );

      // Disabled button contrast and pointer guard
      assert.match(
        cssContent,
        /\.ds-btn:disabled,\s*\.ds-btn\[aria-disabled="true"\]\s*\{[^}]*opacity:\s*0\.5;[^}]*cursor:\s*not-allowed;/s,
      );

      // Pressed button indicator
      assert.match(
        cssContent,
        /\.ds-btn-secondary\[aria-pressed="true"\]\s*\{[^}]*border-color:\s*var\(--atlas-action\);/s,
      );
    });
  });
});
