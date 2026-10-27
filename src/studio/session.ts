import { PNG } from "pngjs";
import { basename, join } from "node:path";
import type { AutomationDriver } from "../driver/types.js";
import { createDriver, inferDriver } from "../driver/registry.js";
import type { DriverKind } from "../types.js";
import { resolveAppPath } from "../config.js";
import { DOM_TARGET_SOURCE } from "../inspector/dom-target.js";
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
  /** Button, field, link, choice, or the visible dot of a custom radio. */
  control?: boolean;
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
let sessionEpoch = 0;
let sessionTail: Promise<void> = Promise.resolve();

/** Connect and disconnect stay in order. A second click cannot close the debug port mid-attach. */
function enqueueSession(task: () => Promise<void>): Promise<void> {
  const run = sessionTail.then(task, task);
  sessionTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function whenSessionIdle(): Promise<void> {
  for (;;) {
    const pending = sessionTail;
    await pending;
    if (sessionTail === pending) return;
  }
}

export class SessionCancelledError extends Error {
  constructor() {
    super("The connection was closed.");
    this.name = "SessionCancelledError";
  }
}

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

export function startSession(flowAppPath?: string, flowDriver?: DriverKind): Promise<void> {
  const ticket = ++sessionEpoch;
  return enqueueSession(() => openSession(ticket, flowAppPath, flowDriver));
}

async function openSession(ticket: number, flowAppPath?: string, flowDriver?: DriverKind): Promise<void> {
  await stopSessionNow();
  if (ticket !== sessionEpoch) throw new SessionCancelledError();
  const config = workspaceConfig();
  const screenshotDir = join(reportRoot(), "studio");
  const appPath = flowAppPath || resolveAppPath(config);
  if (!appPath) {
    throw new Error("Set appPath in the flow to the exe you want to connect.");
  }
  const next = createDriver(inferDriver(flowDriver, appPath));
  try {
    await next.connect({
      appId: basename(appPath),
      locale: "en",
      appPath,
      headless: false,
      screenshotDir
    });
  } catch (err) {
    await next.disconnect().catch(() => {});
    if (ticket !== sessionEpoch) throw new SessionCancelledError();
    throw err;
  }
  if (ticket !== sessionEpoch) {
    await next.disconnect().catch(() => {});
    throw new SessionCancelledError();
  }
  driver = next;
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

export function sessionStamp(): number {
  return sessionEpoch;
}

/**
 * Put a borrowed driver back when the session was left alone.
 * Connect or disconnect during the run owns the session driver, so the run's driver is closed instead.
 */
export async function settleBorrowedDriver(stamp: number, current: AutomationDriver | null): Promise<void> {
  if (stamp !== sessionEpoch) {
    if (current && current !== driver) await current.disconnect().catch(() => {});
    return;
  }
  adoptDriver(current);
}

export function adoptDriver(next: AutomationDriver | null): void {
  driver = next;
  if (!next) {
    target = null;
    return;
  }
  if (!target) target = "app";
}

function oneLine(value: string): string {
  const line = value.trim().split(/\n/)[0] ?? "";
  return line.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function chooseSelector(input: {
  role: string;
  id: string;
  testId: string;
  name: string;
  text: string;
}): string {
  const generatedId = !input.id || /^cl-/.test(input.id) || /-option-\d+$/.test(input.id);
  const text = oneLine(input.text);
  const name = oneLine(input.name);
  if (input.role === "option" && text) return `role:option/${text}`;
  if (input.testId) return input.testId;
  if (!generatedId) return input.id;
  if (
    (input.role === "radio" || input.role === "checkbox" || input.role === "switch") &&
    (name || text)
  ) {
    return `role:${input.role}/${name || text}`;
  }
  if (name) return name;
  return text;
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
${DOM_TARGET_SOURCE}
    const el = document.elementFromPoint(${cssPoint(cssX)}, ${cssPoint(cssY)});
    return solidFlowResolve(el);
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

export function stopSession(): Promise<void> {
  const ticket = ++sessionEpoch;
  return enqueueSession(async () => {
    if (ticket !== sessionEpoch) return;
    await stopSessionNow();
  });
}

async function stopSessionNow(): Promise<void> {
  const current = driver;
  driver = null;
  target = null;
  previewHold = null;
  lastLayout = null;
  if (current) await current.disconnect().catch(() => {});
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

const WINDOW_LIST_MS = 1000;
let listedDriver: AutomationDriver | null = null;
let listedAt = 0;
let listedWindows: { file: string; label: string }[] | null = null;
let listedTask: Promise<{ file: string; label: string }[]> | null = null;

export async function listSwitchWindows(): Promise<{
  connected: boolean;
  windows: { file: string; label: string }[];
}> {
  if (!driver) return { connected: false, windows: [] };
  const current = driver;
  if (listedDriver === current && listedWindows && Date.now() - listedAt < WINDOW_LIST_MS) {
    return { connected: true, windows: listedWindows };
  }
  let task = listedDriver === current ? listedTask : null;
  if (!task) {
    listedDriver = current;
    listedWindows = null;
    task = current.listSwitchWindows();
    listedTask = task;
  }
  try {
    const windows = await task;
    if (driver !== current) return { connected: false, windows: [] };
    listedWindows = windows;
    listedAt = Date.now();
    return { connected: true, windows };
  } catch {
    return { connected: driver === current, windows: [] };
  } finally {
    if (listedDriver === current) listedTask = null;
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
  const webWindow = automation.webWindowFocused();
  const [hierarchy, captured] = await Promise.all([
    captureHierarchy(page).catch(() => null),
    native ? captureNativeFrame(native, hint) : Promise.resolve(null)
  ]);
  let frame = captured;
  if (frame?.popup && webWindow) frame = { ...frame, popup: false };
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
  if (layout) {
    nodes.push(
      ...headerNodes(layout).map(node => ({ ...node, control: true })),
      ...layout.controls.map(node => ({ ...node, control: true }))
    );
  }
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
        bounds,
        ...(node.control ? { control: true } : {})
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
