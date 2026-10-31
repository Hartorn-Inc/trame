import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractWikilinks,
  filterWikiMarkdownForRole,
  parseWikiMarkdown,
  renderWikiLinksToHtml,
} from "../src/notes/wikiParser.ts";
import {
  HandoutRevealManager,
  LightweightElement,
  TrameAppRoot,
  isMobileCompanionMode,
} from "../src/mobile/companionMode.ts";

describe("[E5-T1] Wiki Markdown Parser & Zero-Trust Role Filtering", () => {
  it("extracts [[Entity]] and [[Entity|Custom Label]] wikilinks cleanly", () => {
    const text =
      "The rogue [[Valeros]] visited [[Cragmaw Castle|the fortress]] and retrieved the [[Sunblade]].";
    const links = extractWikilinks(text);

    assert.equal(links.length, 3);
    assert.equal(links[0].target, "Valeros");
    assert.equal(links[0].label, "Valeros");

    assert.equal(links[1].target, "Cragmaw Castle");
    assert.equal(links[1].label, "the fortress");

    assert.equal(links[2].target, "Sunblade");
    assert.equal(links[2].label, "Sunblade");

    const html = renderWikiLinksToHtml(text);
    assert.ok(html.includes('<a class="wiki-entity-link" href="#entity/Valeros" data-entity="Valeros">Valeros</a>'));
    assert.ok(html.includes('<a class="wiki-entity-link" href="#entity/Cragmaw Castle" data-entity="Cragmaw Castle">the fortress</a>'));
  });

  it("parses :::dm and :::handout directive blocks into typed AST", () => {
    const markdown = `# Campaign Log
Party entered the crypt.

:::dm
The lich awaits behind the secret wall at X:200 Y:400.
:::

:::handout{id="h-letter" title="Ancient Parchment" revealed="true"}
Speak friend and enter.
:::

:::handout{id="h-cipher" title="Secret Cipher" revealed="false"}
Key is 42.
:::

End of session.`;

    const parsed = parseWikiMarkdown(markdown);
    assert.equal(parsed.handouts.length, 2);
    assert.equal(parsed.dmBlocks.length, 1);

    assert.equal(parsed.dmBlocks[0].content, "The lich awaits behind the secret wall at X:200 Y:400.");

    assert.equal(parsed.handouts[0].id, "h-letter");
    assert.equal(parsed.handouts[0].title, "Ancient Parchment");
    assert.equal(parsed.handouts[0].revealed, true);
    assert.equal(parsed.handouts[0].content, "Speak friend and enter.");

    assert.equal(parsed.handouts[1].id, "h-cipher");
    assert.equal(parsed.handouts[1].revealed, false);
  });

  it("purges :::dm and unrevealed handouts for non-GM while preserving for GameMaster", () => {
    const markdown = `# Notes
Text
:::dm
GM secret
:::
:::handout{id="h1" title="Revealed Note" revealed="true"}
Open info
:::
:::handout{id="h2" title="Secret Handout" revealed="false"}
Hidden info
:::`;

    const playerView = filterWikiMarkdownForRole(markdown, false);
    assert.ok(!playerView.includes(":::dm"));
    assert.ok(!playerView.includes("GM secret"));
    assert.ok(!playerView.includes("Secret Handout"));
    assert.ok(!playerView.includes("Hidden info"));
    assert.ok(playerView.includes("Revealed Note"));
    assert.ok(playerView.includes("Open info"));

    const gmView = filterWikiMarkdownForRole(markdown, true);
    assert.equal(gmView, markdown);
  });
});

describe("[E5-T1] Mobile Companion Mode (< 768px) & Handout Reveal Modal", () => {
  it("test_mobile_companion_mode_bypasses_pixijs_canvas on viewports < 768px", () => {
    const container = new LightweightElement("div");
    let pixiConstructed = false;

    assert.equal(isMobileCompanionMode(500), true);
    assert.equal(isMobileCompanionMode(767), true);
    assert.equal(isMobileCompanionMode(768), false);
    assert.equal(isMobileCompanionMode(1024), false);

    const root = new TrameAppRoot({
      viewportWidth: 500,
      container,
      onPixiConstructorCalled: () => {
        pixiConstructed = true;
      },
    });

    // Verify Mobile Companion Layout is mounted
    assert.ok(container.querySelector('[data-testid="mobile-companion-layout"]'));
    // Verify TableCanvas is strictly absent and PixiJS was NEVER called
    assert.equal(container.querySelector('[data-testid="table-canvas"]'), null);
    assert.equal(pixiConstructed, false);

    root.destroy();
  });

  it("test_desktop_mode_mounts_table_canvas on viewports >= 768px", () => {
    const container = new LightweightElement("div");
    let pixiConstructed = false;

    const root = new TrameAppRoot({
      viewportWidth: 1024,
      container,
      onPixiConstructorCalled: () => {
        pixiConstructed = true;
      },
    });

    assert.equal(container.querySelector('[data-testid="mobile-companion-layout"]'), null);
    const canvas = container.querySelector('[data-testid="table-canvas"]');
    assert.ok(canvas);
    assert.equal(pixiConstructed, true);

    root.destroy();
  });

  it("test_mobile_companion_tab_navigation between sheet, dice, inventory, and journal", () => {
    const container = new LightweightElement("div");
    const root = new TrameAppRoot({
      viewportWidth: 500,
      container,
    });

    // Initial tab is sheet
    assert.ok(container.querySelector('[data-testid="tab-sheet"]'));

    // Click Dice Roller tab button
    const diceBtn = container.querySelector('[data-testid="tab-button-dice"]');
    assert.ok(diceBtn);
    diceBtn.click();
    assert.equal(container.querySelector('[data-testid="tab-sheet"]'), null);
    assert.ok(container.querySelector('[data-testid="tab-dice"]'));

    // Click Inventory tab button
    const invBtn = container.querySelector('[data-testid="tab-button-inventory"]');
    assert.ok(invBtn);
    invBtn.click();
    assert.equal(container.querySelector('[data-testid="tab-dice"]'), null);
    assert.ok(container.querySelector('[data-testid="tab-inventory"]'));

    // Click Party Journal tab button
    const journalBtn = container.querySelector('[data-testid="tab-button-journal"]');
    assert.ok(journalBtn);
    journalBtn.click();
    assert.equal(container.querySelector('[data-testid="tab-inventory"]'), null);
    assert.ok(container.querySelector('[data-testid="tab-journal"]'));

    // Switch back to Character Sheet
    const sheetBtn = container.querySelector('[data-testid="tab-button-sheet"]');
    assert.ok(sheetBtn);
    sheetBtn.click();
    assert.ok(container.querySelector('[data-testid="tab-sheet"]'));

    root.destroy();
  });

  it("test_handout_reveal_modal_rendering_on_event and party journal appending", () => {
    const container = new LightweightElement("div");
    const handoutManager = new HandoutRevealManager();

    const root = new TrameAppRoot({
      viewportWidth: 1024,
      container,
      handoutManager,
    });

    assert.equal(container.querySelector('[data-testid="handout-reveal-modal"]'), null);

    // Dispatch WebSocket handout.revealed event
    handoutManager.onHandoutRevealed({
      event: "handout.revealed",
      handout_id: "h-777",
      title: "Lettre interceptée",
      content: "Rendez-vous à minuit au vieux moulin.",
      revealed_by: "user-gm-1",
      timestamp: 1717171200000,
    });

    const modal = container.querySelector('[data-testid="handout-reveal-modal"]');
    assert.ok(modal);
    assert.equal(modal.getAttribute("role"), "dialog");
    assert.equal(modal.getAttribute("aria-modal"), "true");
    assert.equal(modal.getAttribute("aria-labelledby"), "handout-title");

    const titleEl = container.querySelector('[data-testid="handout-title"]');
    assert.ok(titleEl);
    assert.equal(titleEl.textContent, "Lettre interceptée");
    assert.equal(titleEl.getAttribute("id"), "handout-title");

    const contentEl = container.querySelector('[data-testid="handout-content"]');
    assert.ok(contentEl);
    assert.equal(contentEl.textContent, "Rendez-vous à minuit au vieux moulin.");

    // Verify Party Journal received the entry
    const journal = handoutManager.getPartyJournal();
    assert.equal(journal.length, 1);
    assert.equal(journal[0].handoutId, "h-777");
    assert.equal(journal[0].title, "Lettre interceptée");

    // Close modal via close button
    const closeBtn = container.querySelector('[data-testid="modal-close-button"]');
    assert.ok(closeBtn);
    closeBtn.click();

    assert.equal(container.querySelector('[data-testid="handout-reveal-modal"]'), null);

    root.destroy();
  });
});
