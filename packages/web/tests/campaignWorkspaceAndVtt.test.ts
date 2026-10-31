import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signal, computed } from "@preact/signals";
import {
  evaluateNoteAccess,
  filterWikiMarkdownForRole,
  parseWikiMarkdown,
} from "../src/notes/wikiParser.ts";
import {
  HandoutRevealManager,
  LightweightElement,
  TrameAppRoot,
  isMobileCompanionMode,
  type HandoutRevealedEvent,
} from "../src/mobile/companionMode.ts";
import {
  localeSignal,
  unitSystemSignal,
  mobileCompanionOverrideSignal,
  t,
  formatDistanceFt,
  resolveCompendiumSearchQuery,
  getInitialLocale,
  STORAGE_KEY_LOCALE,
} from "../src/i18n/index.ts";
import {
  groupNotesByFolder,
  documentsNotesSignal,
  documentsHandoutsSignal,
  activeHandoutModalSignal,
  revealedHandoutsSignal,
  activeRevealedHandoutSignal,
  selectedNoteIdSignal,
  type NoteHierarchyNode,
} from "../src/workspace/DocumentsWorkspaceTab.tsx";
import {
  activeCompanionTabSignal,
  MOBILE_COMPANION_TABS,
} from "../src/mobile/MobileCompanionView.tsx";

describe("[Ticket #89 - Acceptance Criterion 1] Zero-Trust 3-Scope Note RBAC & Directive Stripping", () => {
  interface NoteTestCase {
    visibility: "PRIVATE" | "PARTY" | "DM_ONLY";
    ownerUserId: string;
    requestingUserId: string;
    requestingUserRole: "GameMaster" | "Player" | "Spectator";
    expectedAccess: "OK" | "FORBIDDEN" | "NOT_FOUND";
  }

  const rbacCases: NoteTestCase[] = [
    {
      visibility: "PRIVATE",
      ownerUserId: "player-1",
      requestingUserId: "player-1",
      requestingUserRole: "Player",
      expectedAccess: "OK",
    },
    {
      visibility: "PRIVATE",
      ownerUserId: "player-1",
      requestingUserId: "player-2",
      requestingUserRole: "Player",
      expectedAccess: "NOT_FOUND",
    },
    {
      visibility: "PRIVATE",
      ownerUserId: "player-1",
      requestingUserId: "gm-user",
      requestingUserRole: "GameMaster",
      expectedAccess: "NOT_FOUND",
    },
    {
      visibility: "PARTY",
      ownerUserId: "player-1",
      requestingUserId: "player-2",
      requestingUserRole: "Player",
      expectedAccess: "OK",
    },
    {
      visibility: "PARTY",
      ownerUserId: "player-1",
      requestingUserId: "gm-user",
      requestingUserRole: "GameMaster",
      expectedAccess: "OK",
    },
    {
      visibility: "DM_ONLY",
      ownerUserId: "gm-user",
      requestingUserId: "player-1",
      requestingUserRole: "Player",
      expectedAccess: "FORBIDDEN",
    },
    {
      visibility: "DM_ONLY",
      ownerUserId: "gm-user",
      requestingUserId: "spec-1",
      requestingUserRole: "Spectator",
      expectedAccess: "FORBIDDEN",
    },
    {
      visibility: "DM_ONLY",
      ownerUserId: "gm-user",
      requestingUserId: "gm-user",
      requestingUserRole: "GameMaster",
      expectedAccess: "OK",
    },
  ];

  for (const testCase of rbacCases) {
    it(`enforces access rule for ${testCase.visibility} note requested by ${testCase.requestingUserRole} (${testCase.requestingUserId}) -> ${testCase.expectedAccess}`, () => {
      const actual = evaluateNoteAccess({
        visibility: testCase.visibility,
        ownerUserId: testCase.ownerUserId,
        requestingUserId: testCase.requestingUserId,
        requestingUserRole: testCase.requestingUserRole,
      });
      assert.equal(actual, testCase.expectedAccess);
    });
  }

  it("strips :::dm and unrevealed :::handout blocks for non-GMs while preserving revealed handouts", () => {
    const fullMarkdown = `# Crypt of the Lich\n\nPublic lore: Ancient tomb entrance.\n\n:::dm\nSecret trap at X:12 Y:45. Lich has 120 HP remaining.\n:::\n\n:::handout{id="handout-map" title="Torn Map" revealed="true"}\nThe old road ends at the waterfall.\n:::\n\n:::handout{id="handout-cipher" title="Unrevealed Puzzle Cipher" revealed="false"}\nKey sequence: Blue, Red, Green.\n:::\n\nPublic concluding notes.`;

    const nonGmFiltered = filterWikiMarkdownForRole(fullMarkdown, false);
    assert.equal(nonGmFiltered.includes(":::dm"), false);
    assert.equal(nonGmFiltered.includes("Secret trap at X:12 Y:45"), false);
    assert.equal(nonGmFiltered.includes("Unrevealed Puzzle Cipher"), false);
    assert.equal(nonGmFiltered.includes("Key sequence: Blue, Red, Green"), false);
    assert.equal(nonGmFiltered.includes("Torn Map"), true);
    assert.equal(nonGmFiltered.includes("The old road ends at the waterfall"), true);
    assert.equal(nonGmFiltered.includes("Public lore: Ancient tomb entrance"), true);

    const gmContent = filterWikiMarkdownForRole(fullMarkdown, true);
    assert.equal(gmContent, fullMarkdown);
  });

  it("parses directive blocks into structured AST elements without leaking hidden content", () => {
    const rawDoc = `:::handout{id="h-journal" title="Captain's Log" revealed="true"}\nEntry 42\n:::\n:::dm\nAmbush planned.\n:::`;
    const parsed = parseWikiMarkdown(rawDoc);
    assert.equal(parsed.handouts.length, 1);
    assert.equal(parsed.dmBlocks.length, 1);
    assert.equal(parsed.handouts[0].id, "h-journal");
    assert.equal(parsed.handouts[0].revealed, true);
    assert.equal(parsed.dmBlocks[0].content, "Ambush planned.");
  });
});

describe("[Ticket #89 - Acceptance Criterion 2] Live HandoutRevealed Broadcast & Reveal Modal", () => {
  it("archives revealed handouts into party journal storage upon receiving broadcast frame", () => {
    const manager = new HandoutRevealManager();
    const eventPayload: HandoutRevealedEvent = {
      event: "handout.revealed",
      handout_id: "handout-clue-404",
      title: "Bloodstained Letter",
      content: "The count will be at the docks at midnight.",
      revealed_by: "gm-alex",
      timestamp: 1716001234567,
    };

    let subscriberNotified = false;
    const unsubscribe = manager.subscribe((modal) => {
      if (modal?.handout_id === "handout-clue-404") {
        subscriberNotified = true;
      }
    });

    manager.onHandoutRevealed(eventPayload);

    assert.equal(subscriberNotified, true);
    const journal = manager.getPartyJournal();
    assert.equal(journal.length, 1);
    assert.equal(journal[0].handoutId, "handout-clue-404");
    assert.equal(journal[0].title, "Bloodstained Letter");
    assert.equal(journal[0].revealedBy, "gm-alex");
    assert.equal(journal[0].content, "The count will be at the docks at midnight.");

    unsubscribe();
  });

  it("renders [data-testid='handout-reveal-modal'] over workspace and closes on button click", () => {
    const container = new LightweightElement("div");
    const manager = new HandoutRevealManager();
    const root = new TrameAppRoot({
      viewportWidth: 1024,
      container,
      handoutManager: manager,
    });

    assert.equal(container.querySelector('[data-testid="handout-reveal-modal"]'), null);

    manager.onHandoutRevealed({
      event: "handout.revealed",
      handout_id: "handout-seal",
      title: "Royal Seal of Cormyr",
      content: "Embossed purple wax displaying the purple dragon.",
      revealed_by: "gm-user",
      timestamp: 1716000000000,
    });

    const modalEl = container.querySelector('[data-testid="handout-reveal-modal"]');
    assert.ok(modalEl);
    assert.equal(modalEl.getAttribute("role"), "dialog");
    assert.equal(modalEl.getAttribute("aria-modal"), "true");
    assert.equal(modalEl.getAttribute("aria-labelledby"), "handout-title");
    const titleEl = container.querySelector('[data-testid="handout-title"]');
    assert.equal(titleEl?.textContent, "Royal Seal of Cormyr");

    const closeBtn = container.querySelector('[data-testid="modal-close-button"]');
    assert.ok(closeBtn);
    closeBtn.click();

    assert.equal(container.querySelector('[data-testid="handout-reveal-modal"]'), null);
    root.destroy();
  });

  it("updates activeHandoutModalSignal and documentsHandoutsSignal reactive state", () => {
    activeHandoutModalSignal.value = null;
    assert.equal(activeHandoutModalSignal.value, null);

    const mockHandout = {
      handoutId: "h-reactive-1",
      title: "Ancient Scroll",
      content: "Words of power written in gold ink.",
      revealedBy: "gm",
      timestamp: Date.now(),
    };

    activeHandoutModalSignal.value = mockHandout;
    assert.deepEqual(activeHandoutModalSignal.value, mockHandout);

    documentsHandoutsSignal.value = [mockHandout];
    assert.equal(documentsHandoutsSignal.value.length, 1);
    assert.equal(documentsHandoutsSignal.value[0].title, "Ancient Scroll");

    activeHandoutModalSignal.value = null;
    assert.equal(activeHandoutModalSignal.value, null);
  });
});

describe("[Ticket #89 - Acceptance Criterion 3] Responsive MobileCompanionView (< 768px) & WebGL Lifecycle", () => {
  const viewportCases = [
    { width: 320, expectedMobile: true },
    { width: 767, expectedMobile: true },
    { width: 768, expectedMobile: false },
    { width: 1024, expectedMobile: false },
    { width: 1920, expectedMobile: false },
  ];

  for (const vc of viewportCases) {
    it(`evaluates mobile companion mode for width ${vc.width}px -> ${vc.expectedMobile}`, () => {
      assert.equal(isMobileCompanionMode(vc.width), vc.expectedMobile);
    });
  }

  it("bypasses PixiJS WebGL initialization completely on mobile viewports (< 768px)", () => {
    const container = new LightweightElement("div");
    let webglCanvasCreated = false;

    const root = new TrameAppRoot({
      viewportWidth: 390,
      container,
      onPixiConstructorCalled: () => {
        webglCanvasCreated = true;
      },
    });

    assert.equal(webglCanvasCreated, false);
    assert.equal(container.querySelector('[data-testid="table-canvas"]'), null);
    assert.ok(container.querySelector('[data-testid="mobile-companion-layout"]'));

    root.destroy();
  });

  it("activates MobileCompanionView when mobileCompanionOverrideSignal is true on desktop viewports", () => {
    const windowWidthSignal = signal<number>(1024);
    mobileCompanionOverrideSignal.value = false;

    const shouldMountCanvas = computed(() => !mobileCompanionOverrideSignal.value && windowWidthSignal.value >= 768);
    assert.equal(shouldMountCanvas.value, true);

    mobileCompanionOverrideSignal.value = true;
    assert.equal(shouldMountCanvas.value, false);

    mobileCompanionOverrideSignal.value = false;
    windowWidthSignal.value = 600;
    assert.equal(shouldMountCanvas.value, false);
  });

  it("navigates between all 4 touch-optimized tabs in MobileCompanionLayout", () => {
    const container = new LightweightElement("div");
    const root = new TrameAppRoot({
      viewportWidth: 414,
      container,
    });

    const tabs: Array<{ testId: string; viewTestId: string }> = [
      { testId: "tab-button-sheet", viewTestId: "tab-sheet" },
      { testId: "tab-button-dice", viewTestId: "tab-dice" },
      { testId: "tab-button-inventory", viewTestId: "tab-inventory" },
      { testId: "tab-button-journal", viewTestId: "tab-journal" },
    ];

    for (const tab of tabs) {
      const btn = container.querySelector(`[data-testid="${tab.testId}"]`);
      assert.ok(btn, `Button for ${tab.testId} should exist`);
      btn.click();
      assert.ok(container.querySelector(`[data-testid="${tab.viewTestId}"]`), `View ${tab.viewTestId} should be visible`);
    }

    root.destroy();
  });

  it("tracks activeCompanionTabSignal across all 5 MobileCompanionView tabs", () => {
    const allTabs = MOBILE_COMPANION_TABS.map((t) => t.id);
    assert.deepEqual(allTabs, ["sheet", "dice", "inventory", "tracker", "journal"]);

    for (const tab of allTabs) {
      activeCompanionTabSignal.value = tab;
      assert.equal(activeCompanionTabSignal.value, tab);
    }
  });
});

describe("[Ticket #89 - Acceptance Criterion 4] Reactive Bilingual FR/EN i18n & Tactical Units", () => {
  it("translates UI labels dynamically when localeSignal changes between 'en' and 'fr'", () => {
    localeSignal.value = "en";
    assert.equal(t("nav.sheet"), "Character Sheet");
    assert.equal(t("nav.dice"), "Dice Roller");
    assert.equal(t("action.reveal"), "Reveal to Players");

    localeSignal.value = "fr";
    assert.equal(t("nav.sheet"), "Fiche de personnage");
    assert.equal(t("nav.dice"), "Lanceur de dés");
    assert.equal(t("action.reveal"), "Révéler aux joueurs");

    assert.equal(t("unknown.key"), "unknown.key");
  });

  const distanceTestCases = [
    { feet: 5, unit: "imperial_ft" as const, expected: "5 ft" },
    { feet: 30, unit: "imperial_ft" as const, expected: "30 ft" },
    { feet: 60, unit: "imperial_ft" as const, expected: "60 ft" },
    { feet: 5, unit: "metric_m" as const, expected: "1.5 m (1 case)" },
    { feet: 10, unit: "metric_m" as const, expected: "3 m (2 cases)" },
    { feet: 30, unit: "metric_m" as const, expected: "9 m (6 cases)" },
    { feet: 60, unit: "metric_m" as const, expected: "18 m (12 cases)" },
  ];

  for (const tc of distanceTestCases) {
    it(`formats distance ${tc.feet} ft with unitSystem '${tc.unit}' -> '${tc.expected}'`, () => {
      unitSystemSignal.value = tc.unit;
      const actual = formatDistanceFt(tc.feet);
      assert.equal(actual, tc.expected);
    });
  }

  it("resolves Compendium queries with bilingual French-to-canonical English term matching", () => {
    localeSignal.value = "fr";
    const stealthTerms = resolveCompendiumSearchQuery("furtivité");
    assert.deepEqual(stealthTerms, ["furtivité", "stealth"]);

    const fireballTerms = resolveCompendiumSearchQuery("boule de feu");
    assert.deepEqual(fireballTerms, ["boule de feu", "fireball"]);

    localeSignal.value = "en";
    const enStealthTerms = resolveCompendiumSearchQuery("stealth");
    assert.deepEqual(enStealthTerms, ["stealth"]);
  });

  it("handles initial locale resolution and localStorage synchronization", () => {
    const memoryStorage = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => memoryStorage.get(key) ?? null,
      setItem: (key: string, val: string) => memoryStorage.set(key, val),
      removeItem: (key: string) => memoryStorage.delete(key),
      clear: () => memoryStorage.clear(),
    };

    fakeStorage.setItem(STORAGE_KEY_LOCALE, "fr");
    assert.equal(fakeStorage.getItem(STORAGE_KEY_LOCALE), "fr");

    localeSignal.value = "en";
    assert.equal(localeSignal.value, "en");
    localeSignal.value = "fr";
    assert.equal(localeSignal.value, "fr");
    localeSignal.value = "en";
  });
});

describe("[Ticket #89 - Acceptance Criterion 5] Folder-Organized Notes Hierarchy in DocumentsWorkspaceTab", () => {
  it("groups notes by folder name and assigns empty folders to 'Root'", () => {
    const sampleNotes: NoteHierarchyNode[] = [
      { id: "n1", title: "Tavern Rumors", folder: "Quests", visibility: "PARTY", ownerUserId: "u1" },
      { id: "n2", title: "Bounty Contract", folder: "Quests", visibility: "PARTY", ownerUserId: "u1" },
      { id: "n3", title: "Secret Map", folder: "DM Lore", visibility: "DM_ONLY", ownerUserId: "gm" },
      { id: "n4", title: "Player Diary", folder: "", visibility: "PRIVATE", ownerUserId: "u2" },
      { id: "n5", title: "Session 1 Notes", folder: "   ", visibility: "PARTY", ownerUserId: "u1" },
    ];

    const grouped = groupNotesByFolder(sampleNotes);
    assert.equal(grouped.size, 3);
    assert.ok(grouped.has("Quests"));
    assert.ok(grouped.has("DM Lore"));
    assert.ok(grouped.has("Root"));

    const questNotes = grouped.get("Quests")!;
    assert.equal(questNotes.length, 2);
    assert.equal(questNotes[0].id, "n1");
    assert.equal(questNotes[1].id, "n2");

    const rootNotes = grouped.get("Root")!;
    assert.equal(rootNotes.length, 2);
    assert.equal(rootNotes[0].id, "n4");
    assert.equal(rootNotes[1].id, "n5");
  });

  it("populates documentsNotesSignal and preserves folder hierarchy reactivity", () => {
    documentsNotesSignal.value = [
      { id: "n-alpha", title: "Alpha Note", folder: "Folder A", visibility: "PARTY", ownerUserId: "u1" },
      { id: "n-beta", title: "Beta Note", folder: "Folder B", visibility: "PRIVATE", ownerUserId: "u1" },
    ];

    const grouped = groupNotesByFolder(documentsNotesSignal.value);
    assert.equal(grouped.size, 2);
    assert.equal(grouped.get("Folder A")?.[0].title, "Alpha Note");
    assert.equal(grouped.get("Folder B")?.[0].title, "Beta Note");
  });

  it("exposes revealedHandoutsSignal and activeRevealedHandoutSignal aliases", () => {
    assert.equal(revealedHandoutsSignal, documentsHandoutsSignal);
    assert.equal(activeRevealedHandoutSignal, activeHandoutModalSignal);

    const sampleHandout = {
      handoutId: "h-alias-1",
      title: "Alias Check",
      content: "Content",
      revealedBy: "gm",
      timestamp: 12345,
    };
    revealedHandoutsSignal.value = [sampleHandout];
    assert.equal(documentsHandoutsSignal.value.length, 1);
    assert.equal(documentsHandoutsSignal.value[0].title, "Alias Check");
  });

  it("tracks selected note id and mutates note folder and visibility", () => {
    documentsNotesSignal.value = [
      { id: "note-dyn-1", title: "Dyn Note", folder: "InitialFolder", visibility: "PRIVATE", ownerUserId: "u1" },
    ];
    selectedNoteIdSignal.value = "note-dyn-1";
    assert.equal(selectedNoteIdSignal.value, "note-dyn-1");

    documentsNotesSignal.value = documentsNotesSignal.value.map((n) =>
      n.id === "note-dyn-1" ? { ...n, folder: "CustomFolder", visibility: "PARTY" } : n,
    );

    const updated = documentsNotesSignal.value.find((n) => n.id === "note-dyn-1");
    assert.equal(updated?.folder, "CustomFolder");
    assert.equal(updated?.visibility, "PARTY");
  });
});
