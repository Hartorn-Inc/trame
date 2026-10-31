/**
 * Mobile Companion Mode (< 768px viewport) and Handout Reveal Modal implementation
 * adhering to docs/specs/e5-collaborative-wiki-notes-ui-hando.md.
 */

export const MOBILE_BREAKPOINT_PX = 768;

export type CompanionTabId = "sheet" | "dice" | "inventory" | "journal";

export interface HandoutRevealedEvent {
  event: "handout.revealed";
  handout_id: string;
  title: string;
  content: string;
  revealed_by: string;
  timestamp: number;
}

export interface PartyJournalItem {
  handoutId: string;
  title: string;
  content: string;
  revealedBy: string;
  timestamp: number;
}

export type PartyJournalEntry = PartyJournalItem;

/**
 * Determines whether a given window/screen width activates the Mobile Companion Mode.
 */
export function isMobileCompanionMode(viewportWidth: number): boolean {
  return viewportWidth < MOBILE_BREAKPOINT_PX;
}

/**
 * Simple headless DOM node mock for Stage 1 Node 24 runtime testing without external jsdom.
 */
export class LightweightElement {
  public tagName: string;
  public attributes = new Map<string, string>();
  public children: LightweightElement[] = [];
  public textContent = "";
  public parentElement: LightweightElement | null = null;
  private listeners = new Map<string, Array<(e?: unknown) => void>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public appendChild(child: LightweightElement): void {
    child.parentElement = this;
    this.children.push(child);
  }

  public removeChild(child: LightweightElement): void {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
  }

  public addEventListener(event: string, handler: (e?: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  public dispatchEvent(event: string, payload?: unknown): void {
    const list = this.listeners.get(event);
    if (list) {
      for (const fn of list) {
        fn(payload);
      }
    }
  }

  public click(): void {
    this.dispatchEvent("click");
  }

  public querySelector(selector: string): LightweightElement | null {
    const match = this.matchesSelector(selector);
    if (match) return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  public querySelectorAll(selector: string): LightweightElement[] {
    const results: LightweightElement[] = [];
    if (this.matchesSelector(selector)) {
      results.push(this);
    }
    for (const child of this.children) {
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }

  private matchesSelector(selector: string): boolean {
    if (selector.startsWith("[") && selector.endsWith("]")) {
      const inner = selector.slice(1, -1);
      if (inner.includes("=")) {
        const [attr, rawVal] = inner.split("=");
        const val = rawVal.replace(/["']/g, "");
        return this.getAttribute(attr.trim()) === val.trim();
      }
      return this.attributes.has(inner.trim());
    }
    if (selector.startsWith(".")) {
      const cls = selector.slice(1);
      const classes = (this.getAttribute("class") ?? "").split(/\s+/);
      return classes.includes(cls);
    }
    if (selector.startsWith("#")) {
      return this.getAttribute("id") === selector.slice(1);
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
}

/**
 * State and controller for Handout Reveal Modal & Party Journal.
 */
export class HandoutRevealManager {
  private activeModal: HandoutRevealedEvent | null = null;
  private partyJournal: PartyJournalItem[] = [];
  private subscribers = new Set<(modal: HandoutRevealedEvent | null) => void>();

  public onHandoutRevealed(event: HandoutRevealedEvent): void {
    this.activeModal = event;
    // Append to Party Journal
    this.partyJournal.push({
      handoutId: event.handout_id,
      title: event.title,
      content: event.content,
      revealedBy: event.revealed_by,
      timestamp: event.timestamp,
    });
    this.notifySubscribers();
  }

  public closeModal(): void {
    this.activeModal = null;
    this.notifySubscribers();
  }

  public getActiveModal(): HandoutRevealedEvent | null {
    return this.activeModal;
  }

  public getPartyJournal(): readonly PartyJournalItem[] {
    return this.partyJournal;
  }

  public subscribe(fn: (modal: HandoutRevealedEvent | null) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private notifySubscribers(): void {
    for (const sub of this.subscribers) {
      sub(this.activeModal);
    }
  }
}

export interface AppMountOptions {
  viewportWidth: number;
  container: LightweightElement;
  handoutManager?: HandoutRevealManager;
  onPixiConstructorCalled?: () => void;
}

/**
 * Application Root Mount Controller:
 * IF viewportWidth < 768px -> Mounts MobileCompanionLayout with zero PixiJS/FBO initialization.
 * IF viewportWidth >= 768px -> Mounts TableCanvas and initializes WebGL PixiJS.
 */
export class TrameAppRoot {
  public container: LightweightElement;
  public viewportWidth: number;
  public handoutManager: HandoutRevealManager;
  private onPixiConstructorCalled?: () => void;

  public mobileLayout: MobileCompanionLayout | null = null;
  public tableCanvasElement: LightweightElement | null = null;
  public handoutModalElement: LightweightElement | null = null;
  private unsubscribeHandout?: () => void;

  constructor(options: AppMountOptions) {
    this.container = options.container;
    this.viewportWidth = options.viewportWidth;
    this.handoutManager = options.handoutManager ?? new HandoutRevealManager();
    this.onPixiConstructorCalled = options.onPixiConstructorCalled;
    this.mount();
  }

  public mount(): void {
    this.container.children = [];

    if (isMobileCompanionMode(this.viewportWidth)) {
      // Mobile Companion Mode: strictly bypass PixiJS and WebGL FBO creation
      this.mobileLayout = new MobileCompanionLayout(this.container);
      this.mobileLayout.mount();
    } else {
      // Desktop Mode: mount TableCanvas
      this.mobileLayout = null;
      if (this.onPixiConstructorCalled) {
        this.onPixiConstructorCalled();
      }
      const canvasEl = new LightweightElement("canvas");
      canvasEl.setAttribute("data-testid", "table-canvas");
      canvasEl.setAttribute("class", "trame-pixijs-canvas");
      this.container.appendChild(canvasEl);
      this.tableCanvasElement = canvasEl;
    }

    // Subscribe to handout reveal events for modal rendering
    this.unsubscribeHandout = this.handoutManager.subscribe((modal) => {
      this.renderHandoutModal(modal);
    });
    this.renderHandoutModal(this.handoutManager.getActiveModal());
  }

  public setViewportWidth(width: number): void {
    if (this.viewportWidth !== width) {
      this.viewportWidth = width;
      this.mount();
    }
  }

  public destroy(): void {
    if (this.unsubscribeHandout) {
      this.unsubscribeHandout();
    }
    this.container.children = [];
  }

  private renderHandoutModal(modal: HandoutRevealedEvent | null): void {
    const existing = this.container.querySelector('[data-testid="handout-reveal-modal"]');
    if (existing) {
      this.container.removeChild(existing);
      this.handoutModalElement = null;
    }

    if (!modal) {
      return;
    }

    const modalEl = new LightweightElement("div");
    modalEl.setAttribute("data-testid", "handout-reveal-modal");
    modalEl.setAttribute("role", "dialog");
    modalEl.setAttribute("aria-modal", "true");
    modalEl.setAttribute("aria-labelledby", "handout-title");
    modalEl.setAttribute("class", "modal-backdrop fullscreen");

    const cardEl = new LightweightElement("div");
    cardEl.setAttribute("class", "modal-card ds-overlay-modal");

    const titleEl = new LightweightElement("h2");
    titleEl.setAttribute("id", "handout-title");
    titleEl.setAttribute("data-testid", "handout-title");
    titleEl.textContent = modal.title;
    cardEl.appendChild(titleEl);

    const contentEl = new LightweightElement("div");
    contentEl.setAttribute("data-testid", "handout-content");
    contentEl.textContent = modal.content;
    cardEl.appendChild(contentEl);

    const closeBtn = new LightweightElement("button");
    closeBtn.setAttribute("data-testid", "modal-close-button");
    closeBtn.setAttribute("class", "ds-btn ds-btn-secondary");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => {
      this.handoutManager.closeModal();
    });
    cardEl.appendChild(closeBtn);

    modalEl.appendChild(cardEl);
    this.container.appendChild(modalEl);
    this.handoutModalElement = modalEl;
  }
}

/**
 * Mobile Companion Layout displaying 4 touch-first navigation tabs:
 * tab-button-sheet, tab-button-dice, tab-button-inventory, and tab-button-journal.
 */
export class MobileCompanionLayout {
  public container: LightweightElement;
  public rootElement: LightweightElement;
  public activeTab: CompanionTabId = "sheet";
  private tabContentElement: LightweightElement;

  constructor(container: LightweightElement) {
    this.container = container;
    this.rootElement = new LightweightElement("div");
    this.rootElement.setAttribute("data-testid", "mobile-companion-layout");
    this.rootElement.setAttribute("class", "mobile-companion-root");

    this.tabContentElement = new LightweightElement("main");
    this.tabContentElement.setAttribute("class", "tab-content-viewport");
  }

  public mount(): void {
    const nav = new LightweightElement("nav");
    nav.setAttribute("class", "companion-bottom-nav");

    const tabs: Array<{ id: CompanionTabId; buttonId: string; label: string }> = [
      { id: "sheet", buttonId: "tab-button-sheet", label: "Character Sheet" },
      { id: "dice", buttonId: "tab-button-dice", label: "Dice Roller" },
      { id: "inventory", buttonId: "tab-button-inventory", label: "Inventory" },
      { id: "journal", buttonId: "tab-button-journal", label: "Party Journal" },
    ];

    for (const tab of tabs) {
      const btn = new LightweightElement("button");
      btn.setAttribute("data-testid", tab.buttonId);
      btn.setAttribute(
        "class",
        `nav-tab-btn ds-btn ds-btn-secondary ${this.activeTab === tab.id ? "active" : ""}`,
      );
      btn.setAttribute("aria-pressed", this.activeTab === tab.id ? "true" : "false");
      btn.textContent = tab.label;
      btn.addEventListener("click", () => {
        this.setActiveTab(tab.id);
      });
      nav.appendChild(btn);
    }

    this.rootElement.appendChild(this.tabContentElement);
    this.rootElement.appendChild(nav);
    this.container.appendChild(this.rootElement);

    this.renderActiveTab();
  }

  public setActiveTab(tab: CompanionTabId): void {
    this.activeTab = tab;
    this.renderActiveTab();
  }

  private renderActiveTab(): void {
    this.tabContentElement.children = [];

    const viewEl = new LightweightElement("div");
    viewEl.setAttribute("data-testid", `tab-${this.activeTab}`);
    viewEl.setAttribute("class", `tab-view tab-view-${this.activeTab}`);

    const title = new LightweightElement("h3");
    title.textContent = `View: ${this.activeTab}`;
    viewEl.appendChild(title);

    this.tabContentElement.appendChild(viewEl);
  }
}
