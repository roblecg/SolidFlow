import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOM_TARGET_SOURCE } from "../src/inspector/dom-target.js";
import { HIERARCHY_SCRIPT, type HierarchyNode } from "../src/inspector/hierarchy.js";
import { RECORDER_INIT_SCRIPT } from "../src/recorder/script.js";
import { chooseSelector } from "../src/studio/session.js";

const hitTest = new Function(`${readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/studio/public/inspect-hit.js"), "utf8")}; return solidFlowHitTest;`)() as (
  nodes: Array<{ selector: string; label: string; control?: boolean; bounds: { x: number; y: number; width: number; height: number } }>,
  x: number,
  y: number,
  frame: { width: number; height: number }
) => { selector: string; label: string; bounds: { width: number; height: number } } | null;

function rect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
}

function buildPage() {
  const byId = new Map<string, MockEl>();
  function readText(el: MockEl): string {
    if (el.explicitText != null) return el.explicitText;
    const parts: string[] = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const value = String(child.nodeValue || "").trim();
        if (value) parts.push(value);
      } else if (child.nodeType === 1) {
        const value = readText(child as MockEl);
        if (value) parts.push(value);
      }
    }
    return parts.join("\n");
  }
  function matches(node: MockEl, sel: string): boolean {
    const input = /^input\[type='([^']+)'\]$/.exec(sel);
    if (input) return node.tagName === "INPUT" && (node.getAttribute("type") || "text").toLowerCase() === input[1];
    const role = /^\[role='([^']+)'\]$/.exec(sel);
    if (role) return (node.getAttribute("role") || "").toLowerCase() === role[1];
    return node.tagName === sel.toUpperCase();
  }
  function queryAll(root: MockEl, selector: string): MockEl[] {
    const parts = selector.split(",").map(part => part.trim());
    const found: MockEl[] = [];
    const visit = (node: MockEl) => {
      if (node !== root && parts.some(part => matches(node, part))) found.push(node);
      for (const child of node.children) visit(child);
    };
    visit(root);
    return found;
  }
  function collectText(node: MockEl, out: MockText[]) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out.push(child as MockText);
      else if (child.nodeType === 1) collectText(child as MockEl, out);
    }
  }
  function findId(node: MockEl, id: string): MockEl | null {
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = findId(child, id);
      if (found) return found;
    }
    for (const child of node.shadowRoot?.children ?? []) {
      const found = findId(child, id);
      if (found) return found;
    }
    return null;
  }

  type MockText = { nodeType: 3; nodeValue: string; rects: ReturnType<typeof rect>[] };
  type MockEl = {
    nodeType: 1;
    tagName: string;
    id: string;
    parentElement: MockEl | null;
    shadowHost?: MockEl;
    children: MockEl[];
    childNodes: Array<MockEl | MockText>;
    attrs: Record<string, string>;
    bounds: ReturnType<typeof rect>;
    explicitText?: string;
    labels: MockEl[];
    shadowRoot: { host: MockEl; children: MockEl[] } | null;
    style: { display: string; visibility: string; opacity: string; borderTopLeftRadius?: string };
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    getBoundingClientRect(): ReturnType<typeof rect>;
    readonly innerText: string;
    readonly textContent: string;
    querySelectorAll(selector: string): MockEl[];
    getRootNode(): { host?: MockEl };
  };

  function make(tag: string, props: { id?: string; bounds: ReturnType<typeof rect>; attrs?: Record<string, string>; text?: string; style?: Partial<MockEl["style"]> }): MockEl {
    const node = {
      nodeType: 1 as const,
      tagName: tag.toUpperCase(),
      id: props.id || "",
      parentElement: null,
      children: [] as MockEl[],
      childNodes: [] as Array<MockEl | MockText>,
      attrs: { ...(props.attrs || {}) },
      bounds: props.bounds,
      explicitText: props.text,
      labels: [] as MockEl[],
      shadowRoot: null,
      style: { display: "block", visibility: "visible", opacity: "1", ...(props.style || {}) },
      getAttribute(name: string) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null;
      },
      hasAttribute(name: string) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name);
      },
      getBoundingClientRect() {
        return this.bounds;
      },
      get innerText() {
        return readText(this);
      },
      get textContent() {
        return readText(this);
      },
      querySelectorAll(selector: string) {
        return queryAll(this, selector);
      },
      getRootNode() {
        let cur: MockEl = this;
        while (cur.parentElement) cur = cur.parentElement;
        if (cur.shadowHost) return { host: cur.shadowHost };
        return document;
      }
    };
    if (node.id) byId.set(node.id, node);
    return node;
  }
  function add(parent: MockEl, child: MockEl) {
    child.parentElement = parent;
    parent.children.push(child);
    parent.childNodes.push(child);
    return child;
  }
  function addText(parent: MockEl, value: string, bounds: ReturnType<typeof rect>) {
    parent.childNodes.push({ nodeType: 3, nodeValue: value, rects: [bounds] });
  }
  function attach(host: MockEl, child: MockEl) {
    if (!host.shadowRoot) host.shadowRoot = { host, children: [] };
    child.parentElement = null;
    child.shadowHost = host;
    host.shadowRoot.children.push(child);
    return child;
  }

  const html = make("html", { bounds: rect(0, 0, 800, 600) });
  const body = add(html, make("body", { bounds: rect(0, 0, 800, 600) }));
  const app = add(body, make("div", { id: "app", bounds: rect(0, 0, 800, 600) }));
  const host = add(app, make("custom-radio", { bounds: rect(40, 120, 520, 72) }));
  const wrap = attach(host, make("div", { bounds: rect(40, 120, 520, 72) }));
  const dot = add(wrap, make("span", { bounds: rect(52, 140, 16, 16) }));
  const input = add(wrap, make("input", {
    attrs: { type: "radio" },
    bounds: rect(52, 140, 16, 16),
    style: { opacity: "0" }
  }));
  const title = add(wrap, make("span", { text: "Keep folder hierarchy", bounds: rect(80, 128, 180, 18) }));
  const blurb = add(wrap, make("span", { text: "Preserve the KCIM folder structure", bounds: rect(80, 150, 300, 16) }));
  const roleCard = add(app, make("div", { attrs: { role: "radio" }, bounds: rect(40, 220, 520, 72) }));
  const roleDot = add(roleCard, make("span", {
    bounds: rect(52, 246, 16, 16),
    style: { borderTopLeftRadius: "8px" }
  }));
  add(roleCard, make("span", { text: "Download to a single folder", bounds: rect(80, 236, 220, 18) }));
  const button = add(app, make("button", { bounds: rect(0, 0, 800, 600) }));
  add(button, make("svg", { bounds: rect(16, 536, 16, 16) }));
  addText(button, "Advanced settings", rect(40, 540, 150, 18));

  const document = {
    documentElement: html,
    getElementById(id: string) {
      return findId(html, id);
    },
    createTreeWalker(root: MockEl) {
      const texts: MockText[] = [];
      collectText(root, texts);
      let index = 0;
      return { nextNode: () => texts[index++] || null };
    },
    createRange() {
      return {
        node: null as MockText | null,
        selectNodeContents(node: MockText) {
          this.node = node;
        },
        getClientRects() {
          return this.node?.rects ?? [];
        }
      };
    }
  };
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle(el: MockEl) {
      return el.style;
    }
  };
  return { window, document, app, dot, input, title, blurb, button, wrap, roleDot };
}

function flat(node: HierarchyNode, out: HierarchyNode[] = []): HierarchyNode[] {
  out.push(node);
  for (const child of node.children) flat(child, out);
  return out;
}

describe("inspect targets", () => {
  it("parses the injected target scripts", () => {
    expect(() => new Function(DOM_TARGET_SOURCE)).not.toThrow();
    expect(() => new Function(HIERARCHY_SCRIPT)).not.toThrow();
    expect(() => new Function(RECORDER_INIT_SCRIPT)).not.toThrow();
  });

  it("selects a custom radio dot and keeps a stretched button off the full window", () => {
    const page = buildPage();
    const tree = new Function("window", "document", "NodeFilter", `return (${HIERARCHY_SCRIPT});`)(
      page.window,
      page.document,
      { SHOW_TEXT: 4 }
    ) as HierarchyNode;
    const nodes = flat(tree);
    const dot = nodes.find(node => node.control && node.bounds?.width === 16 && node.bounds?.height === 16);
    const button = nodes.find(node => node.tag === "button");
    const shell = nodes.find(node => node.id === "app");
    const hiddenInput = nodes.find(node => node.tag === "input");

    expect(hiddenInput).toBeUndefined();
    expect(dot).toMatchObject({
      role: "radio",
      text: "Keep folder hierarchy",
      control: true,
      bounds: { x: 52, y: 140, width: 16, height: 16 }
    });
    expect(button).toMatchObject({ tag: "button", text: "Advanced settings", control: true });
    expect(button?.bounds?.width ?? 1000).toBeLessThan(300);
    expect(button?.bounds?.height ?? 1000).toBeLessThan(80);
    expect(button?.bounds?.y ?? 0).toBeGreaterThan(400);
    expect(shell?.control).toBeUndefined();
    expect(shell?.bounds).toMatchObject({ width: 800, height: 600 });

    const resolved = new Function("window", "document", "NodeFilter", `${DOM_TARGET_SOURCE}; return solidFlowResolve;`)(
      page.window,
      page.document,
      { SHOW_TEXT: 4 }
    ) as (el: unknown) => { selector: string; label: string; control: boolean; bounds: { width: number; height: number } } | null;
    expect(resolved(page.dot)).toMatchObject({
      selector: "role:radio/Keep folder hierarchy",
      label: "Keep folder hierarchy",
      control: true,
      bounds: { width: 16, height: 16 }
    });
    expect(resolved(page.button)?.selector).toBe("Advanced settings");
    expect(resolved(page.button)?.bounds.width ?? 1000).toBeLessThan(300);
    expect(resolved(page.app)).toBeNull();
    expect(resolved(page.roleDot)).toMatchObject({
      selector: "role:radio/Download to a single folder",
      label: "Download to a single folder",
      bounds: { width: 16, height: 16 }
    });
    expect(chooseSelector({
      role: dot?.role ?? "",
      id: dot?.id ?? "",
      testId: dot?.testId ?? "",
      name: dot?.name ?? "",
      text: dot?.text ?? ""
    })).toBe("role:radio/Keep folder hierarchy");
  });

  it("outlines the radio dot and the advanced button instead of the page", () => {
    const frame = { width: 800, height: 600 };
    const shell = { selector: "app", label: "app", control: false, bounds: { x: 0, y: 0, width: 800, height: 600 } };
    const button = {
      selector: "Advanced settings",
      label: "Advanced settings",
      control: true,
      bounds: { x: 10, y: 530, width: 186, height: 34 }
    };
    const card = {
      selector: "role:radio/Keep folder hierarchy",
      label: "Keep folder hierarchy",
      control: true,
      bounds: { x: 40, y: 120, width: 520, height: 72 }
    };
    const dot = {
      selector: "role:radio/Keep folder hierarchy",
      label: "Keep folder hierarchy",
      control: true,
      bounds: { x: 52, y: 140, width: 16, height: 16 }
    };
    const blurb = {
      selector: "Preserve the KCIM folder structure",
      label: "Preserve the KCIM folder structure",
      control: false,
      bounds: { x: 80, y: 150, width: 300, height: 16 }
    };
    const nodes = [shell, card, dot, blurb, button];

    expect(hitTest(nodes, 60, 148, frame)).toMatchObject({
      selector: "role:radio/Keep folder hierarchy",
      label: "Keep folder hierarchy",
      bounds: { width: 16, height: 16 }
    });
    expect(hitTest(nodes, 100, 158, frame)?.selector).toBe("Preserve the KCIM folder structure");
    expect(hitTest(nodes, 50, 546, frame)).toMatchObject({ selector: "Advanced settings", label: "Advanced settings" });
    expect(hitTest(nodes, 400, 300, frame)).toBeNull();
  });
});
