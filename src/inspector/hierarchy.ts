import type { Page } from "playwright-core";
import { DOM_TARGET_SOURCE } from "./dom-target.js";

export type HierarchyNode = {
  tag: string;
  id?: string;
  testId?: string;
  role?: string;
  name?: string;
  text?: string;
  /** A button, field, link, radio, checkbox, or the visible dot of a custom choice. */
  control?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  xpath?: string;
  children: HierarchyNode[];
};

export const HIERARCHY_SCRIPT = `(() => {
${DOM_TARGET_SOURCE}
  function xpath(el) {
    if (el.id) return '//*[@id="' + el.id + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      let ix = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) ix++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(cur.tagName.toLowerCase() + "[" + ix + "]");
      cur = cur.parentElement;
    }
    return "/" + parts.join("/");
  }

  function childElements(el) {
    const kids = Array.from(el.children || []);
    if (el.shadowRoot && el.shadowRoot.children) kids.push(...Array.from(el.shadowRoot.children));
    return kids;
  }

  function walk(el, depth) {
    if (!el || depth > 40) return null;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return null;
    const control = solidFlowIsControl(el);
    const rect = control ? solidFlowTightBounds(el) : el.getBoundingClientRect();
    const accessible = control || (el.children || []).length === 0 ? solidFlowAccessibleName(el) : "";
    const role = solidFlowTargetRole(el);
    const node = {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      testId: el.getAttribute("data-testid") || undefined,
      role: role || undefined,
      name: el.getAttribute("aria-label") || undefined,
      text: accessible || undefined,
      control: control || undefined,
      bounds:
        rect.width > 0 && rect.height > 0
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : undefined,
      xpath: xpath(el),
      children: []
    };
    for (const child of childElements(el)) {
      const next = walk(child, depth + 1);
      if (next) node.children.push(next);
    }
    return node;
  }

  return walk(document.documentElement, 0) || { tag: "html", children: [] };
})()`;

export async function captureHierarchy(page: Page): Promise<HierarchyNode> {
  return page.evaluate(HIERARCHY_SCRIPT);
}
