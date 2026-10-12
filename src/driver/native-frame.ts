import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as Readline } from "node:readline";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { Page } from "playwright-core";
import { FlowError } from "../types.js";
import { packageRoot } from "../util/paths.js";

export type Rect = { x: number; y: number; width: number; height: number };

export type FrameNode = {
  tag: string;
  selector: string;
  label: string;
  bounds: Rect;
};

/** Geometry of a native window, in the preview image's pixels. */
export type FrameLayout = {
  title: string;
  /** Middle caption button is Restore (window is zoomed or minimized). */
  maximized: boolean;
  width: number;
  height: number;
  client: Rect;
  buttons: Rect;
  /** This image is a native dialog, such as a folder picker, rather than the app page. */
  popup: boolean;
  controls: FrameNode[];
};

export type NativeFrame = FrameLayout & { png: Buffer };

export type NativeApp = { pid: number; appPath: string; hwnd?: string };

export type NativePopup = { hwnd: string; title: string };

export type PixelHint = { width: number; height: number; cssWidth: number; cssHeight: number };

export type WindowControl = "close" | "minimize" | "maximize" | "restore" | "title";

export type CaptionAction = "close" | "minimize" | "maximize" | "title" | "toggleZoom";

const WINDOW_CONTROL = /^window:(close|minimize|maximize|restore|title)$/;

export function parseWindowControl(selector: string): WindowControl | null {
  const match = WINDOW_CONTROL.exec(selector.trim());
  return (match?.[1] as WindowControl | undefined) ?? null;
}

export function captionActionFor(command: string, selector: string): CaptionAction | null {
  const control = parseWindowControl(selector);
  if (!control) return null;
  if (control === "title") return command === "doubleTapOn" ? "toggleZoom" : "title";
  if (control === "maximize" || control === "restore") return "maximize";
  if (control === "close") return "close";
  if (control === "minimize") return "minimize";
  return null;
}

export function headerNodes(layout: FrameLayout): FrameNode[] {
  if (layout.client.y < 8 || layout.width < 16) return [];
  const height = layout.client.y;
  const buttons = usableButtons(layout);
  const left = Math.min(layout.width, Math.max(0, Math.round(buttons.x)));
  const nodes: FrameNode[] = [];
  if (left >= 4) {
    nodes.push({
      tag: "window",
      selector: "window:title",
      label: layout.title || "Window",
      bounds: { x: 0, y: 0, width: left, height }
    });
  }
  const specs = [
    ["window:minimize", "Minimize"],
    ["window:maximize", layout.maximized ? "Restore" : "Maximize"],
    ["window:close", "Close"]
  ] as const;
  const slice = (layout.width - left) / 3;
  specs.forEach((spec, index) => {
    const x = left + slice * index;
    const right = index === 2 ? layout.width : left + slice * (index + 1);
    const width = right - x;
    if (width < 4) return;
    nodes.push({
      tag: "window",
      selector: spec[0],
      label: spec[1],
      bounds: { x, y: 0, width, height }
    });
  });
  return nodes;
}

export function hitHeader(layout: FrameLayout, x: number, y: number): FrameNode | null {
  return hitNode(headerNodes(layout), x, y);
}

export function hitNode(nodes: FrameNode[], x: number, y: number): FrameNode | null {
  const hits = nodes.filter(node => contains(node.bounds, x, y));
  hits.sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
  return hits[0] ?? null;
}

export function chooseNativePopup(
  windows: NativePopup[],
  baseline: ReadonlySet<string>,
  adopted: ReadonlySet<string>
): NativePopup | null {
  return windows.find(window => window.hwnd && !baseline.has(window.hwnd) && !adopted.has(window.hwnd)) ?? null;
}

export function imageToPage(
  layout: FrameLayout,
  x: number,
  y: number,
  cssWidth: number,
  cssHeight: number
): { x: number; y: number } | null {
  const localX = x - layout.client.x;
  const localY = y - layout.client.y;
  if (layout.client.width <= 0 || layout.client.height <= 0) return null;
  if (localX < 0 || localY < 0 || localX > layout.client.width || localY > layout.client.height) return null;
  if (cssWidth <= 0 || cssHeight <= 0) return null;
  return {
    x: (localX / layout.client.width) * cssWidth,
    y: (localY / layout.client.height) * cssHeight
  };
}

export function clipRect(bounds: Rect, clip: Rect): Rect | null {
  const x = Math.max(bounds.x, clip.x);
  const y = Math.max(bounds.y, clip.y);
  const right = Math.min(bounds.x + bounds.width, clip.x + clip.width);
  const bottom = Math.min(bounds.y + bounds.height, clip.y + clip.height);
  if (right - x < 4 || bottom - y < 4) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function compositePageIntoFrame(framePng: Buffer, pagePng: Buffer, client: Rect): Buffer {
  const frame = PNG.sync.read(framePng);
  const page = PNG.sync.read(pagePng);
  revealTitlePixels(frame);
  blit(frame, page, client);
  return PNG.sync.write(frame);
}

export function presentFrame(framePng: Buffer): Buffer {
  const frame = PNG.sync.read(framePng);
  revealTitlePixels(frame);
  return PNG.sync.write(frame);
}

export async function pagePixelHint(page: Page): Promise<PixelHint | undefined> {
  try {
    const metrics = await page.evaluate<{ w: number; h: number; dpr: number }>(
      "({ w: window.innerWidth || 0, h: window.innerHeight || 0, dpr: window.devicePixelRatio || 1 })"
    );
    if (!metrics?.w || !metrics?.h) return undefined;
    const dpr = metrics.dpr > 0 ? metrics.dpr : 1;
    return {
      width: Math.round(metrics.w * dpr),
      height: Math.round(metrics.h * dpr),
      cssWidth: metrics.w,
      cssHeight: metrics.h
    };
  } catch {
    return undefined;
  }
}

export async function captureNativeFrame(app: NativeApp, hint?: PixelHint): Promise<NativeFrame | null> {
  if (process.platform !== "win32") return null;
  try {
    const response = await helperRequest({ op: "capture", ...requestFields(app, hint) });
    if (!response?.ok || !response.pngPath) {
      lastCaptureError = response?.error || "Window capture did not return an image";
      return null;
    }
    const png = await readPng(response.pngPath);
    const layout = layoutFrom(response);
    const size = png ? pngSize(png) : null;
    if (!png || !layout || !size || size.width !== layout.width || size.height !== layout.height) {
      lastCaptureError = "Window capture did not include a title bar";
      return null;
    }
    lastCaptureError = "";
    return { ...layout, png };
  } catch (err) {
    lastCaptureError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

export async function nativeControlVisible(
  app: NativeApp,
  selector: string,
  hint?: PixelHint
): Promise<boolean> {
  const control = parseWindowControl(selector);
  if (!control || process.platform !== "win32") return false;
  const response = await helperRequest({ op: "query", ...requestFields(app, hint) });
  if (!response?.ok) {
    if (response?.error === "window not found") return false;
    throw new FlowError(response?.error || "Could not check the window title bar.");
  }
  const layout = layoutFrom(response);
  if (!layout) return false;
  const nodes = headerNodes(layout);
  if (control === "title") return nodes.some(node => node.selector === "window:title");
  if (control === "maximize" || control === "restore") {
    return nodes.some(node => node.selector === "window:maximize");
  }
  return nodes.some(node => node.selector === `window:${control}`);
}

export async function listNativePopups(app: NativeApp): Promise<NativePopup[]> {
  if (process.platform !== "win32") return [];
  const response = await helperRequest({ op: "windows", procId: app.pid, appPath: app.appPath });
  if (!response?.ok || !Array.isArray(response.windows)) return [];
  return response.windows
    .filter(window => typeof window.hwnd === "string" && window.hwnd && typeof window.title === "string")
    .map(window => ({ hwnd: window.hwnd as string, title: window.title as string }));
}

export async function invokeNativeControl(app: NativeApp, name: string): Promise<void> {
  const response = await nativeUi(app, "invoke", name);
  if (!response?.ok) throw new FlowError(response?.error || `${name} is not in the window.`);
}

export async function nativeTextVisible(app: NativeApp, name: string): Promise<boolean> {
  const response = await nativeUi(app, "visible", name);
  if (!response?.ok) {
    if (response?.error === "window not found") return false;
    throw new FlowError(response?.error || "Could not check the window.");
  }
  return response.visible === true;
}

export async function setNativeText(app: NativeApp, name: string, text: string): Promise<void> {
  const response = await nativeUi(app, "value", name, text);
  if (!response?.ok) throw new FlowError(response?.error || "Could not type into the window.");
}

export async function readNativeText(app: NativeApp, name: string): Promise<string> {
  const response = await nativeUi(app, "read", name);
  if (!response?.ok) throw new FlowError(response?.error || "Could not read the window.");
  return response.text ?? "";
}

async function nativeUi(app: NativeApp, op: string, name: string, text = ""): Promise<HelperResponse | null> {
  if (process.platform !== "win32") {
    throw new FlowError("Native windows are available on the connected Windows app.");
  }
  if (!app.hwnd) throw new FlowError("The folder window is no longer open.");
  try {
    return await helperRequest({ op, ...requestFields(app), name, text });
  } catch (err) {
    throw new FlowError(err instanceof Error ? err.message : "Could not use the window.");
  }
}

export async function performCaptionAction(
  app: NativeApp,
  action: CaptionAction,
  hint?: PixelHint
): Promise<void> {
  if (process.platform !== "win32") {
    throw new FlowError("Window title bar controls are available on the connected Windows app.");
  }
  let response: HelperResponse | null = null;
  try {
    response = await helperRequest({ op: "caption", action, ...requestFields(app, hint) });
  } catch (err) {
    throw new FlowError(err instanceof Error ? err.message : "Could not use the window title bar.");
  }
  if (!response?.ok) {
    throw new FlowError(response?.error || "The app window is not available.");
  }
}

export function stopNativeFrameHost(): void {
  host?.stop();
  host = null;
}

function usableButtons(layout: FrameLayout): Rect {
  const buttons = layout.buttons;
  const plausible =
    buttons.width >= 24 &&
    buttons.height >= 8 &&
    buttons.x >= layout.width * 0.2 &&
    buttons.x < layout.width - 12;
  if (plausible) return buttons;
  const one = Math.round(Math.max(layout.client.y, 28) * 1.45);
  const width = Math.min(layout.width, one * 3);
  return { x: layout.width - width, y: 0, width, height: layout.client.y };
}

function contains(bounds: Rect, x: number, y: number): boolean {
  return x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height;
}

function revealTitlePixels(frame: PNG): void {
  for (let i = 0; i < frame.data.length; i += 4) {
    const alpha = frame.data[i + 3] ?? 0;
    if (alpha >= 250) continue;
    const color = (frame.data[i] ?? 0) + (frame.data[i + 1] ?? 0) + (frame.data[i + 2] ?? 0);
    if (color > 30) frame.data[i + 3] = 255;
  }
}

function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 16 || height < 16) return null;
  return { width, height };
}

function blit(dest: PNG, src: PNG, rect: Rect): void {
  if (rect.width <= 0 || rect.height <= 0) return;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(dest.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(dest.height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y++) {
    const sy =
      src.height <= 1 ? 0 : Math.min(src.height - 1, Math.floor(((y - rect.y) / rect.height) * src.height));
    for (let x = x0; x < x1; x++) {
      const sx =
        src.width <= 1 ? 0 : Math.min(src.width - 1, Math.floor(((x - rect.x) / rect.width) * src.width));
      const di = (y * dest.width + x) * 4;
      const si = (sy * src.width + sx) * 4;
      dest.data[di] = src.data[si] ?? 0;
      dest.data[di + 1] = src.data[si + 1] ?? 0;
      dest.data[di + 2] = src.data[si + 2] ?? 0;
      dest.data[di + 3] = 255;
    }
  }
}

type HelperResponse = {
  ok?: boolean;
  error?: string;
  title?: string;
  maximized?: boolean;
  width?: number;
  height?: number;
  client?: Rect;
  buttons?: Rect;
  pngPath?: string;
  popup?: boolean;
  visible?: boolean;
  text?: string;
  windows?: { hwnd?: string; title?: string }[];
  controls?: { name?: string; kind?: string; bounds?: Rect }[];
};

function requestFields(app: NativeApp, hint?: PixelHint): Record<string, number | string> {
  return {
    procId: app.pid,
    appPath: app.appPath,
    hintW: hint?.width ?? 0,
    hintH: hint?.height ?? 0,
    cssW: hint?.cssWidth ?? 0,
    cssH: hint?.cssHeight ?? 0,
    ...(app.hwnd ? { hwnd: app.hwnd } : {})
  };
}

function layoutFrom(response: HelperResponse): FrameLayout | null {
  const client = finiteRect(response.client);
  const buttons = finiteRect(response.buttons);
  const width = Number(response.width);
  const height = Number(response.height);
  if (!client || !buttons || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 16 || height < 16 || client.y < 8 || client.y >= height) return null;
  const fitted = {
    x: Math.max(0, client.x),
    y: client.y,
    width: client.width,
    height: client.height
  };
  if (fitted.x >= width) return null;
  if (fitted.x + fitted.width > width) fitted.width = width - fitted.x;
  if (fitted.y + fitted.height > height) fitted.height = height - fitted.y;
  if (fitted.width < 20 || fitted.height < 20) return null;
  return {
    title: response.title ?? "",
    maximized: response.maximized === true,
    width,
    height,
    client: fitted,
    buttons,
    popup: response.popup === true,
    controls: controlsFrom(response.controls)
  };
}

function controlsFrom(value: HelperResponse["controls"]): FrameNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: FrameNode[] = [];
  for (const item of value) {
    const bounds = finiteRect(item?.bounds);
    const name = item?.name?.trim() ?? "";
    if (!bounds || !name || bounds.width < 4 || bounds.height < 4) continue;
    nodes.push({ tag: item?.kind || "control", selector: name, label: name, bounds });
  }
  return nodes;
}

function finiteRect(value: Rect | undefined): Rect | null {
  if (!value) return null;
  const rect = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height)
  };
  if (!Object.values(rect).every(Number.isFinite)) return null;
  return rect;
}

async function readPng(pngPath: string): Promise<Buffer | null> {
  const safe = safePngPath(pngPath);
  if (!safe) return null;
  try {
    return await readFile(safe);
  } catch {
    return null;
  } finally {
    await rm(safe, { force: true }).catch(() => {});
  }
}

function safePngPath(value: string): string | null {
  if (!value.toLowerCase().endsWith(".png")) return null;
  const file = resolve(value);
  const temp = resolve(tmpdir());
  const root = temp.toLowerCase().endsWith("\\") || temp.toLowerCase().endsWith("/") ? temp : `${temp}\\`;
  if (!file.toLowerCase().startsWith(root.toLowerCase())) return null;
  return file;
}

type Pending = {
  resolve: (value: HelperResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

class FrameHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Readline | null = null;
  private pending: Pending | null = null;
  private stderr = "";
  private warmed = false;
  private chain: Promise<unknown> = Promise.resolve();

  request(body: Record<string, unknown>): Promise<HelperResponse> {
    const run = this.chain.then(() => this.send(body));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  stop(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Window capture stopped"));
    }
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    child?.kill();
  }

  private async send(body: Record<string, unknown>): Promise<HelperResponse> {
    const child = this.ensure();
    const timeoutMs = this.warmed ? 4_000 : 20_000;
    const response = await new Promise<HelperResponse>((resolve, reject) => {
      let settled = false;
      const finish = (ok: HelperResponse | null, error?: Error) => {
        if (settled) return;
        settled = true;
        const pending = this.pending;
        this.pending = null;
        if (pending) clearTimeout(pending.timer);
        if (error) reject(error);
        else resolve(ok ?? { ok: false, error: "Window capture failed" });
      };
      const timer = setTimeout(() => {
        this.restart(new Error("Window capture timed out"));
        finish(null, new Error("Window capture timed out"));
      }, timeoutMs);
      this.pending = {
        resolve: value => finish(value),
        reject: error => finish(null, error),
        timer
      };
      child.stdin.write(`${JSON.stringify(body)}\n`, error => {
        if (error) this.restart(error);
      });
    });
    this.warmed = true;
    return response;
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const script = join(packageRoot(), "src", "driver", "native-frame.ps1");
    if (!existsSync(script)) {
      throw new Error("Window capture helper is missing.");
    }
    const root = process.env.SystemRoot || "C:\\Windows";
    const exe = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(
      exe,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    ) as ChildProcessWithoutNullStreams;
    child.unref();
    this.stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    const ignore = () => undefined;
    child.stdin.on("error", ignore);
    child.stdout.on("error", ignore);
    child.stderr.on("error", ignore);
    child.on("error", error => {
      if (this.child === child) this.child = null;
      this.failPending(error);
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.lines?.close();
      this.lines = null;
      this.failPending(new Error(this.stderr.trim() || "Window capture helper stopped"));
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("error", ignore);
    lines.on("line", line => this.onLine(line));
    this.lines = lines;
    this.child = child;
    return child;
  }

  private onLine(line: string): void {
    const pending = this.pending;
    if (!pending || !line.startsWith("{")) return;
    try {
      pending.resolve(JSON.parse(line) as HelperResponse);
    } catch {
      pending.reject(new Error("Window capture returned an unreadable response"));
    }
  }

  private restart(error: Error): void {
    this.failPending(error);
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    child?.kill();
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

let host: FrameHost | null = null;
let lastCaptureError = "";

export function lastNativeFrameError(): string {
  return lastCaptureError;
}

function helperRequest(body: Record<string, unknown>): Promise<HelperResponse> {
  if (!host) host = new FrameHost();
  return host.request(body);
}

process.on("exit", () => {
  host?.stop();
});
