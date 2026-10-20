/**
 * DOM helpers injected into the connected app. Inspect, pick, and record all use
 * this so a custom radio dot and a stretched button resolve the same way.
 * Keep this free of template placeholders (${}) — it is embedded in other scripts.
 */
export const DOM_TARGET_SOURCE = `
function solidFlowParent(el) {
  if (!el) return null;
  if (el.parentElement) return el.parentElement;
  const root = typeof el.getRootNode === "function" ? el.getRootNode() : null;
  if (root && root.host) return root.host;
  return null;
}

function solidFlowFirstLine(value) {
  const raw = String(value || "").trim();
  const line = raw.split(/\\n/)[0] || "";
  return line.replace(/\\s+/g, " ").trim().slice(0, 120);
}

function solidFlowCoversView(rect) {
  if (!rect) return false;
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  return rect.width >= w * 0.8 && rect.height >= h * 0.8;
}

function solidFlowChoiceList(el) {
  if (!el || typeof el.querySelectorAll !== "function") return [];
  return Array.from(el.querySelectorAll("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox'], [role='switch']"));
}

function solidFlowChoiceCount(el) {
  return solidFlowChoiceList(el).length;
}

function solidFlowImplicitRole(el) {
  if (!el || !el.getAttribute) return "";
  const explicit = el.getAttribute("role") || "";
  if (explicit) return explicit.toLowerCase();
  const tag = el.tagName || "";
  if (tag === "BUTTON") return "button";
  if (tag === "A" && el.hasAttribute("href")) return "link";
  if (tag === "SELECT") return "combobox";
  if (tag === "TEXTAREA") return "textbox";
  if (tag === "SUMMARY") return "button";
  if (tag === "OPTION") return "option";
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "radio") return "radio";
    if (type === "checkbox") return "checkbox";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "hidden") return "";
    return "textbox";
  }
  return "";
}

function solidFlowRoleControl(role) {
  return /^(button|link|radio|checkbox|switch|tab|menuitem|menuitemradio|menuitemcheckbox|option|textbox|combobox|listbox|slider|searchbox|spinbutton)$/.test(role);
}

function solidFlowInsideChoice(el) {
  let cur = solidFlowParent(el);
  let guard = 0;
  while (cur && guard < 40) {
    guard += 1;
    const role = solidFlowImplicitRole(cur);
    if (role === "radio" || role === "checkbox" || role === "switch") return true;
    const count = solidFlowChoiceCount(cur);
    if (count === 1 && !solidFlowCoversView(cur.getBoundingClientRect())) return true;
    if (count > 1) return false;
    cur = solidFlowParent(cur);
  }
  return false;
}

function solidFlowNearBox(el, other, pad) {
  const a = el.getBoundingClientRect();
  const b = other.getBoundingClientRect();
  const dx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), 0);
  const dy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height), 0);
  return dx * dx + dy * dy <= pad * pad;
}

function solidFlowIsRound(el) {
  let style = null;
  try {
    style = window.getComputedStyle(el);
  } catch (error) {
    return false;
  }
  const radius = parseFloat(style && style.borderTopLeftRadius) || 0;
  const rect = el.getBoundingClientRect();
  return radius >= Math.min(rect.width, rect.height) * 0.4;
}

function solidFlowIsChoiceDot(el) {
  if (!el || el.nodeType !== 1 || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "BUTTON" || tag === "A" || tag === "LABEL" || tag === "SELECT" || tag === "TEXTAREA" || tag === "OPTION" || tag === "SCRIPT" || tag === "STYLE" || tag === "PATH" || tag === "CIRCLE" || tag === "RECT" || tag === "G") return false;
  const parent = solidFlowParent(el);
  if (parent && parent.tagName === "SVG") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8 || rect.width > 48 || rect.height > 48) return false;
  const ratio = rect.width / Math.max(1, rect.height);
  if (ratio < 0.7 || ratio > 1.45) return false;
  if (solidFlowFirstLine(el.innerText || el.textContent || "")) return false;
  const choice = solidFlowNearbyChoice(el);
  if (!choice || choice === el) return false;
  const role = solidFlowImplicitRole(choice);
  if (role !== "radio" && role !== "checkbox" && role !== "switch") return false;
  if (solidFlowNearBox(el, choice, 36)) return true;
  return solidFlowIsRound(el) && solidFlowInsideChoice(el);
}

function solidFlowOwnsSingleChoice(el) {
  if (!el || solidFlowChoiceCount(el) !== 1) return false;
  const rect = el.getBoundingClientRect();
  if (solidFlowCoversView(rect)) return false;
  const view = (window.innerWidth || 1) * (window.innerHeight || 1);
  if (rect.width * rect.height > view * 0.55) return false;
  return true;
}

function solidFlowIsControl(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY" || tag === "OPTION") return true;
  if (tag === "A" && el.hasAttribute("href")) return true;
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return type !== "hidden";
  }
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (solidFlowRoleControl(role)) return true;
  const rect = el.getBoundingClientRect();
  if (tag === "LABEL") return !solidFlowCoversView(rect);
  if (el.hasAttribute("aria-checked") && !solidFlowCoversView(rect)) return true;
  if (el.getAttribute("data-testid") && !solidFlowCoversView(rect)) return true;
  if (solidFlowOwnsSingleChoice(el)) return true;
  if (solidFlowIsChoiceDot(el)) return true;
  return false;
}

function solidFlowNamed(el) {
  if (!el || !el.getAttribute) return "";
  const aria = solidFlowFirstLine(el.getAttribute("aria-label") || "");
  if (aria) return aria;
  const labelledby = el.getAttribute("aria-labelledby") || "";
  if (labelledby && typeof document.getElementById === "function") {
    const text = labelledby.split(/\\s+/).map(function (id) {
      const node = document.getElementById(id);
      return node ? (node.innerText || node.textContent || "") : "";
    }).join(" ");
    const line = solidFlowFirstLine(text);
    if (line) return line;
  }
  if (el.labels && el.labels.length) {
    const line = solidFlowFirstLine(Array.from(el.labels).map(function (label) {
      return label.innerText || label.textContent || "";
    }).join(" "));
    if (line) return line;
  }
  return "";
}

function solidFlowLabelAncestor(el) {
  let cur = el;
  let guard = 0;
  while (cur && guard < 40) {
    if (cur.tagName === "LABEL") return cur;
    guard += 1;
    cur = solidFlowParent(cur);
  }
  return null;
}

function solidFlowClosestChoice(el, choices) {
  const rect = el.getBoundingClientRect();
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < choices.length; i++) {
    const box = choices[i].getBoundingClientRect();
    const dx = box.x + box.width / 2 - cx;
    const dy = box.y + box.height / 2 - cy;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = choices[i];
    }
  }
  if (!best) return null;
  const box = best.getBoundingClientRect();
  const dx = box.x + box.width / 2 - cx;
  const dy = box.y + box.height / 2 - cy;
  if (dx * dx + dy * dy > 96 * 96) return null;
  return best;
}

function solidFlowIsChoiceElement(el) {
  const role = solidFlowImplicitRole(el);
  return role === "radio" || role === "checkbox" || role === "switch";
}

function solidFlowNearbyChoice(el) {
  let cur = el;
  let guard = 0;
  while (cur && guard < 40) {
    guard += 1;
    if (cur !== el && solidFlowIsChoiceElement(cur)) return cur;
    const choices = solidFlowChoiceList(cur);
    if (choices.length === 1) return choices[0];
    if (choices.length > 1) return solidFlowClosestChoice(el, choices);
    cur = solidFlowParent(cur);
  }
  return null;
}

function solidFlowChoiceName(choice) {
  if (!choice) return "";
  const named = solidFlowNamed(choice);
  if (named) return named;
  const label = solidFlowLabelAncestor(choice);
  if (label && label !== choice) {
    const line = solidFlowFirstLine(label.innerText || label.textContent || "");
    if (line) return line;
  }
  const parent = solidFlowParent(choice);
  if (parent && solidFlowChoiceCount(parent) === 1 && !solidFlowCoversView(parent.getBoundingClientRect())) {
    const line = solidFlowFirstLine(parent.innerText || parent.textContent || "");
    if (line) return line;
  }
  return solidFlowFirstLine(choice.innerText || choice.textContent || "");
}

function solidFlowAccessibleName(el) {
  const named = solidFlowNamed(el);
  if (named) return named;
  if (solidFlowIsChoiceDot(el) || solidFlowOwnsSingleChoice(el)) {
    const choice = solidFlowNearbyChoice(el);
    if (choice && choice !== el) {
      const choiceName = solidFlowChoiceName(choice);
      if (choiceName) return choiceName;
    }
    const label = solidFlowLabelAncestor(el);
    if (label && label !== el) {
      const line = solidFlowFirstLine(label.innerText || label.textContent || "");
      if (line) return line;
    }
  }
  const role = solidFlowImplicitRole(el);
  if ((role === "radio" || role === "checkbox" || role === "switch") && !solidFlowFirstLine(el.innerText || el.textContent || "")) {
    const label = solidFlowLabelAncestor(el);
    if (label && label !== el) {
      const line = solidFlowFirstLine(label.innerText || label.textContent || "");
      if (line) return line;
    }
    const parent = solidFlowParent(el);
    if (parent && solidFlowChoiceCount(parent) === 1 && !solidFlowCoversView(parent.getBoundingClientRect())) {
      const line = solidFlowFirstLine(parent.innerText || parent.textContent || "");
      if (line) return line;
    }
  }
  if (el.tagName === "SELECT" && el.selectedOptions && el.selectedOptions[0]) {
    const selected = solidFlowFirstLine(el.selectedOptions[0].textContent || el.selectedOptions[0].innerText || "");
    if (selected) return selected;
  }
  if (el.getAttribute && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const value = solidFlowFirstLine(el.getAttribute("value") || "");
    if (value && (type === "button" || type === "submit" || type === "reset")) return value;
    const placeholder = solidFlowFirstLine(el.getAttribute("placeholder") || "");
    if (placeholder) return placeholder;
  }
  return solidFlowFirstLine(el.innerText || el.textContent || "");
}

function solidFlowTargetRole(el) {
  const own = solidFlowImplicitRole(el);
  if (own === "radio" || own === "checkbox" || own === "switch" || own === "option") return own;
  if (solidFlowIsChoiceDot(el) || solidFlowOwnsSingleChoice(el)) {
    const choice = solidFlowNearbyChoice(el);
    if (choice) {
      const role = solidFlowImplicitRole(choice);
      if (role === "radio" || role === "checkbox" || role === "switch") return role;
    }
  }
  return own;
}

function solidFlowSelector(el) {
  const role = solidFlowTargetRole(el);
  const id = el.id || "";
  const testId = (el.getAttribute && el.getAttribute("data-testid")) || "";
  const generated = !id || /^cl-/.test(id) || /-option-\\d+$/.test(id);
  const aria = solidFlowFirstLine((el.getAttribute && el.getAttribute("aria-label")) || "");
  const text = solidFlowAccessibleName(el);
  if (role === "option" && text) return "role:option/" + text;
  if (testId) return testId;
  if (!generated) return id;
  if ((role === "radio" || role === "checkbox" || role === "switch") && (aria || text)) return "role:" + role + "/" + (aria || text);
  if (aria) return aria;
  return text;
}

function solidFlowTightBounds(el) {
  const own = el.getBoundingClientRect();
  const fallback = { x: own.x, y: own.y, width: own.width, height: own.height };
  if (!solidFlowCoversView(own)) return fallback;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  function add(rect) {
    if (!rect || rect.width < 2 || rect.height < 2) return;
    if (rect.width >= own.width * 0.92 && rect.height >= own.height * 0.92) return;
    found = true;
    const left = rect.left != null ? rect.left : rect.x;
    const top = rect.top != null ? rect.top : rect.y;
    const right = rect.right != null ? rect.right : left + rect.width;
    const bottom = rect.bottom != null ? rect.bottom : top + rect.height;
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, right);
    maxY = Math.max(maxY, bottom);
  }
  try {
    if (typeof el.querySelectorAll === "function") {
      const icons = el.querySelectorAll("svg, img, canvas");
      for (let i = 0; i < icons.length; i++) add(icons[i].getBoundingClientRect());
    }
    if (typeof document.createTreeWalker === "function" && typeof document.createRange === "function") {
      const showText = (typeof NodeFilter !== "undefined" && NodeFilter.SHOW_TEXT) || 4;
      const walker = document.createTreeWalker(el, showText);
      const range = document.createRange();
      let textNode = walker.nextNode();
      while (textNode) {
        if (String(textNode.nodeValue || "").trim()) {
          range.selectNodeContents(textNode);
          const rects = range.getClientRects();
          for (let i = 0; i < rects.length; i++) add(rects[i]);
        }
        textNode = walker.nextNode();
      }
    }
  } catch (error) {
    return fallback;
  }
  if (!found) return fallback;
  const pad = 6;
  const x = Math.max(own.x, minX - pad);
  const y = Math.max(own.y, minY - pad);
  const right = Math.min(own.x + own.width, maxX + pad);
  const bottom = Math.min(own.y + own.height, maxY + pad);
  if (right - x < 8 || bottom - y < 8) return fallback;
  return { x: x, y: y, width: right - x, height: bottom - y };
}

function solidFlowTextLeaf(el) {
  let cur = el;
  let guard = 0;
  while (cur && guard < 40) {
    guard += 1;
    const rect = cur.getBoundingClientRect();
    if (solidFlowCoversView(rect)) return null;
    const text = solidFlowFirstLine(cur.innerText || cur.textContent || "");
    const childCount = cur.children ? cur.children.length : 0;
    if (childCount === 0 && text) return cur;
    cur = solidFlowParent(cur);
  }
  return null;
}

function solidFlowResolve(el) {
  if (!el || el.nodeType !== 1) return null;
  if (el.id === "__solidFlow_step" || el.id === "__solidFlow_ring") return null;
  let cur = el;
  let guard = 0;
  let control = null;
  while (cur && guard < 40) {
    guard += 1;
    if (solidFlowIsControl(cur)) {
      control = cur;
      break;
    }
    cur = solidFlowParent(cur);
  }
  const target = control || solidFlowTextLeaf(el);
  if (!target) return null;
  const selector = solidFlowSelector(target);
  if (!selector) return null;
  const rect = solidFlowIsControl(target) ? solidFlowTightBounds(target) : target.getBoundingClientRect();
  if (!rect || rect.width < 4 || rect.height < 4) return null;
  if (!solidFlowIsControl(target) && solidFlowCoversView(rect)) return null;
  const label = solidFlowAccessibleName(target) || selector;
  return {
    tag: String(target.tagName || "").toLowerCase(),
    selector: selector,
    label: label,
    control: !!solidFlowIsControl(target),
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  };
}
`;
