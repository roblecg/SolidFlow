import { PNG } from "pngjs";
import { basename, join } from "node:path";
import type { AutomationDriver } from "../driver/types.js";
import { createDriver } from "../driver/registry.js";
import { resolveAppPath } from "../config.js";
import { captureHierarchy, type HierarchyNode } from "../inspector/hierarchy.js";
import { fixturePageUrl } from "../util/paths.js";
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
  target: "app" | "fixture" | null;
  image?: string;
  width?: number;
  height?: number;
  nodes: StudioNode[];
  error?: string;
  /** Changes only when a run publishes a new frame. */
  seq?: number;
};

let driver: AutomationDriver | null = null;
let target: "app" | "fixture" | null = null;
let previewHold: StudioSnapshot | null = null;
let previewSeq = 0;

export function sessionTarget(): "app" | "fixture" | null {
  return target;
}

export async function startSession(next: "app" | "fixture", flowAppPath?: string): Promise<void> {
  await stopSession();
  const config = workspaceConfig();
  const screenshotDir = join(reportRoot(), "studio");
  if (next === "app") {
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
  } else {
    driver = createDriver("chromium");
    await driver.connect({
      appId: "fixture.demo",
      locale: "en",
      fixtureUrl: fixturePageUrl(),
      headless: false,
      viewport: { width: 420, height: 720 },
      screenshotDir
    });
  }
  target = next;
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
  if (!target) {
    target = next.kind === "chromium" ? "fixture" : "app";
  }
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
  const x = Math.min(1, Math.max(0, nx));
  const y = Math.min(1, Math.max(0, ny));
  const page = driver.getPage();
  const picked = await page.evaluate(`(() => {
    const el = document.elementFromPoint(${x} * window.innerWidth, ${y} * window.innerHeight);
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
}

export function clearRunPreview(): void {
  previewHold = null;
}

/** Screenshot the page the run just left current, so the preview can follow a popup. */
export async function publishRunPreview(automation: AutomationDriver): Promise<void> {
  try {
    const frame = await frameOf(automation, target ?? (automation.kind === "chromium" ? "fixture" : "app"));
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
  try {
    return await frameOf(driver, target);
  } catch (err) {
    return {
      connected: false,
      target,
      nodes: [],
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

async function frameOf(
  automation: AutomationDriver,
  sessionTarget: "app" | "fixture"
): Promise<StudioSnapshot> {
  const page = automation.getPage();
  const buffer = await page.screenshot({ type: "png" });
  let nodes: StudioNode[] = [];
  try {
    const [hierarchy, metrics] = await Promise.all([
      captureHierarchy(page),
      page.evaluate<{ w: number }>("({ w: window.innerWidth || 1 })")
    ]);
    const png = PNG.sync.read(buffer);
    const scale = metrics.w > 0 ? png.width / metrics.w : 1;
    nodes = flatten(hierarchy, scale);
  } catch {
    nodes = [];
  }
  const viewport = page.viewportSize();
  return {
    connected: true,
    target: sessionTarget,
    image: `data:image/png;base64,${buffer.toString("base64")}`,
    width: viewport?.width,
    height: viewport?.height,
    nodes
  };
}

function flatten(node: HierarchyNode, scale: number, out: StudioNode[] = []): StudioNode[] {
  const selector = pickSelector(node);
  if (selector && node.bounds && node.bounds.width >= 4 && node.bounds.height >= 4) {
    out.push({
      tag: node.tag,
      selector,
      label: node.name || node.text || node.id || node.testId || node.tag,
      bounds: {
        x: node.bounds.x * scale,
        y: node.bounds.y * scale,
        width: node.bounds.width * scale,
        height: node.bounds.height * scale
      }
    });
  }
  for (const child of node.children) {
    flatten(child, scale, out);
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
