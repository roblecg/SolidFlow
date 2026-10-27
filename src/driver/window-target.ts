import { FlowError } from "../types.js";

/** Outer window rectangle from the native helper. `dpi` is the window DPI, 96 at 100%. */
export type ScreenBounds = { x: number; y: number; width: number; height: number; dpi?: number };

export type SwitchWindowChoice = {
  file: string;
  /** Document title or the heading in that window, when it differs from the file name. */
  label: string;
};

export type WindowQuery = {
  file?: string;
  title?: string;
  text?: string;
  /** A plain string matches a page file, a caption, or a heading. An object matches every field that is set. */
  any: boolean;
};

const SIZE_TOLERANCE = 32;
const SIZE_GAP = 24;

export function urlMatchesFile(url: string, file: string): boolean {
  const wanted = fileName(file);
  if (!wanted) return false;
  return fileName(urlPath(url)) === wanted;
}

/** The page file a switchToWindow file: value should use, keeping its original case. */
export function pageFileName(url: string): string {
  return segment(urlPath(url));
}

export function parseWindowQuery(value: unknown): WindowQuery {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      throw new FlowError("switchToWindow needs a file name, a window title, or the heading in that window.");
    }
    return { file: text, title: text, text, any: true };
  }
  if (!isRecord(value)) {
    throw new FlowError("switchToWindow needs a file name, a window title, or the heading in that window.");
  }
  const file = readField(value.file);
  const title = readField(value.title);
  const text = readField(value.text);
  if (!file && !title && !text) {
    throw new FlowError("switchToWindow needs file, title, or text.");
  }
  return {
    ...(file ? { file } : {}),
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
    any: false
  };
}

export function describeWindowQuery(query: WindowQuery): string {
  if (query.any) return quote(query.text || query.title || query.file || "window");
  const parts: string[] = [];
  if (query.file) parts.push(`file ${quote(query.file)}`);
  if (query.title) parts.push(`title ${quote(query.title)}`);
  if (query.text) parts.push(`text ${quote(query.text)}`);
  return parts.join(", ");
}

/**
 * Pair a Chrome window rectangle with one visible native window.
 * Chrome reports DIP. The helper reports physical pixels and the window DPI.
 * Returns null when two windows are close enough that the page would be ambiguous.
 */
/** `window.outerWidth` from a page. Electron has no Browser.getWindowForTarget. */
export function outerBounds(value: unknown): { left: number; top: number; width: number; height: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { left?: unknown; top?: unknown; width?: unknown; height?: unknown };
  const width = Number(record.width);
  const height = Number(record.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const left = Number(record.left);
  const top = Number(record.top);
  return {
    left: Number.isFinite(left) ? left : 0,
    top: Number.isFinite(top) ? top : 0,
    width,
    height
  };
}

export function hwndForBounds(
  target: { width: number; height: number },
  windows: readonly { hwnd: string; bounds?: ScreenBounds }[]
): string | null {
  let bestHwnd: string | null = null;
  let best = Number.POSITIVE_INFINITY;
  let second = Number.POSITIVE_INFINITY;
  for (const window of windows) {
    if (!window.bounds) continue;
    const score = boundsScore(target, window.bounds);
    if (score < best) {
      second = best;
      best = score;
      bestHwnd = window.hwnd;
    } else if (score < second) {
      second = score;
    }
  }
  if (bestHwnd === null || best > SIZE_TOLERANCE) return null;
  if (second <= SIZE_TOLERANCE && second - best < SIZE_GAP) return null;
  return bestHwnd;
}

function boundsScore(target: { width: number; height: number }, bounds: ScreenBounds): number {
  const scales = bounds.dpi && bounds.dpi > 0 ? [bounds.dpi / 96] : [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
  let best = Number.POSITIVE_INFINITY;
  for (const scale of scales) {
    if (scale <= 0) continue;
    best = Math.min(
      best,
      Math.abs(target.width - bounds.width / scale) + Math.abs(target.height - bounds.height / scale)
    );
  }
  return best;
}

function urlPath(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

function segment(path: string): string {
  return path.trim().replace(/\\/g, "/").split("/").pop() ?? "";
}

function fileName(path: string): string {
  return segment(path).toLowerCase();
}

function quote(value: string): string {
  return `"${value}"`;
}

function readField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
