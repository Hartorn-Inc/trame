// Minimal DOM mock so Preact can render and dispatch events under node:test.
export function setupMockDom() {
  class MockClassList {
    private classes = new Set<string>();
    add(...tokens: string[]) { tokens.forEach((t) => this.classes.add(t)); }
    remove(...tokens: string[]) { tokens.forEach((t) => this.classes.delete(t)); }
    contains(token: string) { return this.classes.has(token); }
    get length() { return this.classes.size; }
    toString() { return Array.from(this.classes).join(" "); }
  }

  class MockNode {
    nodeType = 1;
    nodeName = "DIV";
    parentNode: MockNode | null = null;
    childNodes: MockNode[] = [];
    attributes: Record<string, string> = {};
    style: Record<string, string> = {};
    classList = new MockClassList();
    data = "";
    _value = "";
    checked = false;
    disabled = false;
    type = "text";
    name = "";
    id = "";
    isSvg = false;
    listeners: Record<string, Function[]> = {};

    constructor(nodeName: string = "DIV", nodeType: number = 1) {
      this.nodeName = nodeName.toUpperCase();
      this.nodeType = nodeType;
    }

    get textContent(): string {
      if (this.nodeType === 3) return this.data;
      return this.childNodes.map((c) => c.textContent).join("");
    }
    set textContent(val: string) {
      this.childNodes = [];
      if (val) {
        const textNode = new MockNode("#text", 3);
        textNode.data = String(val);
        textNode.parentNode = this;
        this.childNodes.push(textNode);
      }
    }

    get value(): string {
      return this._value;
    }
    set value(v: string) {
      this._value = String(v);
    }

    get firstChild(): MockNode | null {
      return this.childNodes[0] || null;
    }
    get lastChild(): MockNode | null {
      return this.childNodes[this.childNodes.length - 1] || null;
    }
    get nextSibling(): MockNode | null {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx >= 0 && idx + 1 < this.parentNode.childNodes.length ? this.parentNode.childNodes[idx + 1] : null;
    }

    appendChild<T extends MockNode>(child: T): T {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }

    insertBefore<T extends MockNode>(newChild: T, refChild: MockNode | null): T {
      if (!refChild) return this.appendChild(newChild);
      if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
      const idx = this.childNodes.indexOf(refChild);
      if (idx === -1) return this.appendChild(newChild);
      newChild.parentNode = this;
      this.childNodes.splice(idx, 0, newChild);
      return newChild;
    }

    removeChild<T extends MockNode>(child: T): T {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) {
        child.parentNode = null;
        this.childNodes.splice(idx, 1);
      }
      return child;
    }

    remove() {
      if (this.parentNode) {
        this.parentNode.removeChild(this);
      }
    }

    focus() {
      if (typeof document !== "undefined") {
        (document as any).activeElement = this;
      }
    }

    blur() {
      if (typeof document !== "undefined" && (document as any).activeElement === this) {
        (document as any).activeElement = null;
      }
    }

    contains(other: MockNode | null): boolean {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    // HTML attribute names are case-insensitive (Preact writes `tabIndex` via
    // setAttribute); SVG names such as `viewBox` keep their case.
    attrName(name: string): string {
      return this.isSvg ? name : name.toLowerCase();
    }

    setAttribute(rawName: string, value: any) {
      const name = this.attrName(rawName);
      const strVal = String(value);
      this.attributes[name] = strVal;
      if (name === "class") {
        this.classList = new MockClassList();
        strVal.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
      }
      if (name === "id") this.id = strVal;
      if (name === "type") this.type = strVal;
      if (name === "name") this.name = strVal;
      if (name === "value") this._value = strVal;
      if (name === "disabled") this.disabled = Boolean(value);
      if (name === "checked") this.checked = Boolean(value);
    }

    getAttribute(name: string): string | null {
      return this.attributes[this.attrName(name)] ?? null;
    }

    hasAttribute(name: string): boolean {
      return this.attrName(name) in this.attributes;
    }

    removeAttribute(name: string) {
      delete this.attributes[this.attrName(name)];
    }

    addEventListener(type: string, listener: Function) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(listener);
    }

    removeEventListener(type: string, listener: Function) {
      if (!this.listeners[type]) return;
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }

    dispatchEvent(event: { type: string; [k: string]: any }): boolean {
      const target = event.target ?? this;
      let stopped = false;
      const originalStopPropagation = event.stopPropagation;
      const eventObj = {
        preventDefault: () => {},
        ...event,
        target,
        currentTarget: this,
        stopPropagation: () => {
          stopped = true;
          if (typeof originalStopPropagation === "function") {
            originalStopPropagation();
          }
        },
      };
      const list = this.listeners[event.type] || [];
      for (const handler of list) {
        handler.call(this, eventObj);
      }
      if (this.parentNode && (event as any).bubbles !== false && !stopped) {
        this.parentNode.dispatchEvent(eventObj);
      }
      return true;
    }

    matches(selector: string): boolean {
      if (!selector || this.nodeType !== 1) return false;
      if (selector.startsWith("#")) {
        return this.id === selector.slice(1) || this.getAttribute("id") === selector.slice(1);
      }
      if (selector.startsWith(".")) {
        return this.classList.contains(selector.slice(1));
      }
      if (selector.includes(":not(")) {
        const notIdx = selector.indexOf(":not(");
        const base = selector.slice(0, notIdx).trim();
        const inner = selector.slice(notIdx + 5, selector.lastIndexOf(")")).trim();
        if (base && !this.matches(base)) return false;
        return !this.matches(inner);
      }
      const bracketIdx = selector.indexOf("[");
      if (bracketIdx !== -1 && selector.endsWith("]")) {
        const tagPart = selector.slice(0, bracketIdx).trim();
        if (tagPart && this.nodeName.toLowerCase() !== tagPart.toLowerCase()) {
          return false;
        }
        const inner = selector.slice(bracketIdx + 1, -1);
        if (inner.includes("=")) {
          const eqIdx = inner.indexOf("=");
          const attr = inner.slice(0, eqIdx).trim();
          const val = inner.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
          return this.getAttribute(attr) === val || (this as any)[attr] === val;
        }
        if (inner === "disabled") {
          return Boolean(this.disabled || this.hasAttribute("disabled"));
        }
        return this.hasAttribute(inner);
      }
      return this.nodeName.toLowerCase() === selector.toLowerCase();
    }

    closest(selector: string): MockNode | null {
      let cur: MockNode | null = this;
      while (cur) {
        if (cur.matches(selector)) {
          return cur;
        }
        cur = cur.parentNode;
      }
      return null;
    }

    querySelector(selector: string): MockNode | null {
      const all = this.querySelectorAll(selector);
      return all[0] || null;
    }

    querySelectorAll(selector: string): MockNode[] {
      const results: MockNode[] = [];
      const walk = (current: MockNode) => {
        for (const child of current.childNodes) {
          if (child.nodeType === 1) {
            if (child.matches(selector)) results.push(child);
            walk(child);
          }
        }
      };
      walk(this);
      return results;
    }
  }

  // `document` is the end of the bubbling path (body -> html -> document), so
  // document-level listeners such as the modal focus trap see dispatched events.
  const mockDoc = {
    nodeType: 9,
    nodeName: "#document",
    activeElement: null as MockNode | null,
    listeners: {} as Record<string, Function[]>,
    addEventListener(type: string, listener: Function) {
      (this.listeners[type] ??= []).push(listener);
    },
    removeEventListener(type: string, listener: Function) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
    },
    dispatchEvent(event: { type: string; [k: string]: any }): boolean {
      const eventObj = { preventDefault: () => {}, stopPropagation: () => {}, target: mockDoc, ...event };
      for (const handler of [...(this.listeners[event.type] ?? [])]) handler.call(this, eventObj);
      return true;
    },
    createElement(tag: string) {
      return new MockNode(tag, 1);
    },
    createElementNS(ns: string | null, tag: string) {
      const node = new MockNode(tag, 1);
      node.isSvg = ns === "http://www.w3.org/2000/svg";
      return node;
    },
    createTextNode(text: string) {
      const n = new MockNode("#text", 3);
      n.data = String(text);
      return n;
    },
    createDocumentFragment() {
      return new MockNode("#document-fragment", 11);
    },
    documentElement: new MockNode("HTML", 1),
    body: new MockNode("BODY", 1),
  };
  mockDoc.documentElement.appendChild(mockDoc.body);
  (mockDoc.documentElement as any).parentNode = mockDoc;

  (globalThis as any).document = mockDoc;
  (globalThis as any).window = globalThis;
  (globalThis as any).Event = class {
    type: string;
    bubbles = true;
    stopPropagation = () => {};
    preventDefault = () => {};
    constructor(type: string, opts?: any) {
      this.type = type;
      if (opts) Object.assign(this, opts);
    }
  };
  return mockDoc;
}
