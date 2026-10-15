import { PNG } from "pngjs";
import { basename, join } from "node:path";
import type { AutomationDriver } from "../driver/types.js";
import { createDriver } from "../driver/registry.js";
import { resolveAppPath } from "../config.js";
import { captureHierarchy, type HierarchyNode } from "../inspector/hierarchy.js";
import {
  captureNativeFrame,
  clipRect,
  compositePageIntoFrame,
  headerNodes,
  hitHeader,
  hitNode,
  imageToPage,
  listNativePopups,
  pagePixelHint,
  popupMatchingTitle,
  presentFrame,
  type FrameLayout,
  type NativeApp,
  type Rect
} from "../driver/native-frame.js";
import { reportRoot, workspaceConfig } from "./workspace.js";
import { formatRecordedStep, RECORDER_INIT_SCRIPT, type RecordedStep } from "../recorder/script.js";

export type StudioNode = {
  tag: string;
  selector: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
};

export type StudioSnapshot = {
  connected: boolean;
  target: "app" | null;
  image?: string;
  width?: number;
  height?: number;
  nodes: StudioNode[];
  error?: string;
  /** Changes only when a run publishes a new frame. */
  seq?: number;
};

let driver: AutomationDriver | null = null;
let target: "app" | null = null;
let previewHold: StudioSnapshot | null = null;
let previewSeq = 0;
let lastLayout: FrameLayout | null = null;
let frameRunning = false;
let frameLatest: (() => Promise<StudioSnapshot>) | null = null;
let frameWaiters: Array<{
  resolve: (value: StudioSnapshot) => void;
  reject: (error: unknown) => void;
}> = [];

export function sessionTarget(): "app" | null {
  return target;
}

export async function startSession(flowAppPath?: string): Promise<void> {
  await stopSession();
  const config = workspaceConfig();
  const screenshotDir = join(reportRoot(), "studio");
  const appPath = flowAppPath || resolveAppPath(config);
  if (!appPath) {
    throw new Error("Set appPath in the flow to the exe you want to connect.");
  }
  driver = createDriver("webview2");
  await driver.connect({
    appId: basename(appPath),
    locale: "en",
    appPath,
    headless: false,
    screenshotDir
  });
  target = "app";
  const page = driver.getPage();
  await page.addInitScript(RECORDER_INIT_SCRIPT).catch(() => {});
  await page.evaluate(RECORDER_INIT_SCRIPT).catch(() => {});
  await page.bringToFront().catch(() => {});
}

export function borrowDriver(): AutomationDriver | null {
  const current = driver;
  driver = null;
  return current;
}

export function adoptDriver(next: AutomationDriver | null): void {
  driver = next;
  if (!next) {
    target = null;
    return;
  }
  if (!target) target = "app";
}

export function chooseSelector(input: {
  role: string;
  id: string;
  testId: string;
  name: string;
  text: string;
}): string {
  const generatedId = !input.id || /^cl-/.test(input.id) || /-option-\d+$/.test(input.id);
  if (input.role === "option" && input.text) return `role:option/${input.text}`;
  if (input.testId) return input.testId;
  if (!generatedId) return input.id;
  if (input.name) return input.name;
  return input.text;
}

export async function pickAt(nx: number, ny: number): Promise<StudioNode | null> {
  if (!driver) return null;
  const xNorm = Math.min(1, Math.max(0, nx));
  const yNorm = Math.min(1, Math.max(0, ny));
  const page = driver.getPage();
  const layout = lastLayout;
  let cssX: number;
  let cssY: number;
  if (layout && layout.width > 0 && layout.height > 0) {
    const x = xNorm * layout.width;
    const y = yNorm * layout.height;
    const header = hitHeader(layout, x, y);
    if (header) return header;
    const control = hitNode(layout.controls, x, y);
    if (control) return control;
    if (layout.popup) return null;
    const hint = await pagePixelHint(page);
    const point = imageToPage(layout, x, y, hint?.cssWidth ?? 1, hint?.cssHeight ?? 1);
    if (!point) return null;
    cssX = point.x;
    cssY = point.y;
  } else {
    const hint = await pagePixelHint(page);
    cssX = xNorm * (hint?.cssWidth ?? 1);
    cssY = yNorm * (hint?.cssHeight ?? 1);
  }
  const picked = await page.evaluate(`(() => {
    const el = document.elementFromPoint(${cssPoint(cssX)}, ${cssPoint(cssY)});
    if (!el || el.id === "__solidFlow_step" || el.id === "__solidFlow_ring") return null;
    const interesting = el.closest("[role='option'], button, a, input, select, textarea, label, [data-testid]");
    const node = interesting || el;
    const rect = node.getBoundingClientRect();
    const role = node.getAttribute("role") || "";
    const id = node.id || "";
    const testId = node.getAttribute("data-testid") || "";
    const name = node.getAttribute("aria-label") || "";
    const text = (node.innerText || node.textContent || "").trim().split("\\n")[0].slice(0, 80);
    const generatedId = !id || /^cl-/.test(id) || /-option-\\d+$/.test(id);
    let selector = "";
    if (role === "option" && text) selector = "role:option/" + text;
    else if (testId) selector = testId;
    else if (!generatedId) selector = id;
    else if (name) selector = name;
    else selector = text;
    if (!selector) return null;
    return {
      tag: node.tagName.toLowerCase(),
      selector,
      label: name || text || selector,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  })()`);
  return (picked as StudioNode | null) ?? null;
}

export async function drainRecordedLines(): Promise<string[]> {
  if (!driver) return [];
  const steps = await driver.getPage().evaluate(`(() => {
    const rec = window.__solidFlowRecorder;
    if (!rec || rec.paused) return [];
    const steps = rec.steps || [];
    rec.steps = [];
    return steps;
  })()`);
  return ((steps as RecordedStep[] | null) ?? []).map(step => formatRecordedStep(step));
}

export async function setRecordingPaused(paused: boolean): Promise<void> {
  if (!driver) return;
  await driver.getPage().evaluate(`(() => {
    const rec = window.__solidFlowRecorder;
    if (!rec) return;
    rec.paused = ${paused ? "true" : "false"};
    if (${paused ? "true" : "false"}) rec.steps = [];
  })()`).catch(() => {});
}

export async function stopSession(): Promise<void> {
  if (driver) {
    await driver.disconnect().catch(() => {});
  }
  driver = null;
  target = null;
  previewHold = null;
  lastLayout = null;
}

export function clearRunPreview(): void {
  previewHold = null;
}

/** Screenshot the page the run just left current, so the preview can follow a popup. */
export async function publishRunPreview(automation: AutomationDriver): Promise<void> {
  try {
    const frame = await shareFrame(() =>
      frameOf(automation, target ?? "app")
    );
    previewSeq += 1;
    previewHold = { ...frame, seq: previewSeq };
  } catch {
    // Keep the previous frame when the page is mid-navigation.
  }
}

export async function snapshot(): Promise<StudioSnapshot> {
  if (!driver || !target) {
    if (previewHold?.image) return previewHold;
    return { connected: false, target: null, nodes: [] };
  }
  const automation = driver;
  const which = target;
  try {
    return await shareFrame(() => frameOf(automation, which));
  } catch (err) {
    return {
      connected: false,
      target: which,
      nodes: [],
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function shareFrame(work: () => Promise<StudioSnapshot>): Promise<StudioSnapshot> {
  frameLatest = work;
  const result = new Promise<StudioSnapshot>((resolve, reject) => {
    frameWaiters.push({ resolve, reject });
  });
  void pumpFrames();
  return result;
}

async function pumpFrames(): Promise<void> {
  if (frameRunning) return;
  frameRunning = true;
  try {
    while (frameLatest && frameWaiters.length > 0) {
      const work = frameLatest;
      const waiters = frameWaiters;
      frameLatest = null;
      frameWaiters = [];
      try {
        const snap = await work();
        for (const waiter of waiters) waiter.resolve(snap);
      } catch (err) {
        for (const waiter of waiters) waiter.reject(err);
      }
    }
  } finally {
    frameRunning = false;
    if (frameLatest && frameWaiters.length > 0) void pumpFrames();
  }
}

/** When the current page is a popup, capture that window. Otherwise keep the main window. */
async function previewWindow(
  native: NativeApp | null,
  page: import("playwright-core").Page
): Promise<NativeApp | null> {
  if (!native || native.hwnd) return native;
  const title = await page.title().catch(() => "");
  const windows = await listNativePopups(native).catch(() => []);
  const popup = popupMatchingTitle(windows, title);
  if (!popup) return native;
  return { ...native, hwnd: popup.hwnd };
}

async function frameOf(
  automation: AutomationDriver,
  sessionTarget: "app"
): Promise<StudioSnapshot> {
  const page = automation.getPage();
  const buffer = await page.screenshot({ type: "png" });
  const hint = await pagePixelHint(page);
  // The connected app from the flow's appPath, not the SolidFlow studio window.
  const native = await previewWindow(automation.nativeApp(), page);
  const [hierarchy, frame] = await Promise.all([
    captureHierarchy(page).catch(() => null),
    native ? captureNativeFrame(native, hint) : Promise.resolve(null)
  ]);
  let image = buffer;
  let layout: FrameLayout | null = null;
  if (frame?.popup) {
    try {
      image = presentFrame(frame.png);
    } catch {
      image = frame.png;
    }
    layout = frame;
  } else if (frame && frame.client.y >= 8) {
    try {
      image = compositePageIntoFrame(frame.png, buffer, frame.client);
      layout = frame;
    } catch {
      image = buffer;
      layout = null;
    }
  }
  lastLayout = layout;
  const cssW = hint?.cssWidth || 1;
  const cssH = hint?.cssHeight || 1;
  const pageSize = pngSize(buffer);
  const scaleX = layout && !layout.popup ? layout.client.width / cssW : pageSize.width / cssW;
  const scaleY = layout && !layout.popup ? layout.client.height / cssH : pageSize.height / cssH;
  const nodes =
    hierarchy && !layout?.popup
      ? flatten(hierarchy, scaleX, scaleY, layout?.client.x ?? 0, layout?.client.y ?? 0, layout?.client ?? null)
      : [];
  if (layout) nodes.push(...headerNodes(layout), ...layout.controls);
  const size = layout ?? pageSize;
  return {
    connected: true,
    target: sessionTarget,
    image: `data:image/png;base64,${image.toString("base64")}`,
    width: size.width,
    height: size.height,
    nodes
  };
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length >= 24 && buffer.toString("ascii", 12, 16) === "IHDR") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height };
}

function cssPoint(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function flatten(
  node: HierarchyNode,
  scaleX: number,
  scaleY: number,
  originX: number,
  originY: number,
  clip: Rect | null,
  out: StudioNode[] = []
): StudioNode[] {
  const selector = pickSelector(node);
  if (selector && node.bounds && node.bounds.width >= 4 && node.bounds.height >= 4) {
    const mapped = {
      x: node.bounds.x * scaleX + originX,
      y: node.bounds.y * scaleY + originY,
      width: node.bounds.width * scaleX,
      height: node.bounds.height * scaleY
    };
    const bounds = clip ? clipRect(mapped, clip) : mapped.width >= 4 && mapped.height >= 4 ? mapped : null;
    if (bounds) {
      out.push({
        tag: node.tag,
        selector,
        label: node.name || node.text || node.id || node.testId || node.tag,
        bounds
      });
    }
  }
  for (const child of node.children) {
    flatten(child, scaleX, scaleY, originX, originY, clip, out);
  }
  return out;
}

function pickSelector(node: HierarchyNode): string | null {
  const selector = chooseSelector({
    role: node.role ?? "",
    id: node.id ?? "",
    testId: node.testId ?? "",
    name: node.name ?? "",
    text: node.text ?? ""
  });
  return selector || null;
}
