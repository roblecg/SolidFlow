import type { LocatorMatch, DriverKind, DeviceInfo } from "../types.js";
import type { Page } from "playwright-core";
import type { SwitchWindowChoice, WindowQuery } from "./window-target.js";

export type DriverContext = {
  appId: string;
  locale: string;
  appPath?: string;
  /** Page Chromium opens. Desktop flows use appPath instead. */
  pageUrl?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  userDataDir?: string;
  screenshotDir?: string;
  /** Ends the wait for the app to start. */
  signal?: AbortSignal;
};

export interface AutomationDriver {
  readonly kind: DriverKind;
  connect(ctx: DriverContext): Promise<void>;
  disconnect(): Promise<void>;
  clearState(): Promise<void>;
  getPage(): Page;
  getDeviceInfo(): DeviceInfo;
  takeScreenshot(name: string): Promise<string>;
  waitForPopup(timeoutMs: number): Promise<void>;
  switchToMain(): Promise<void>;
  /** Select a window that is already open, or wait until that window is visible. */
  switchToWindow(query: WindowQuery, timeoutMs: number): Promise<void>;
  /** Follow the system-browser page the app just opened. urlPart narrows which address to wait for. */
  switchToBrowser(urlPart: string, timeoutMs: number): Promise<void>;
  /** True after the open browser pages have been remembered. */
  hasBrowserBaseline(): boolean;
  /** Remember the browser pages showing now. Keeps an earlier snapshot when the new page is already in front. */
  noteSystemBrowser(beforeSwitch: boolean): Promise<void>;
  /** Pages the connected app has open, by file name. */
  listSwitchWindows(): Promise<SwitchWindowChoice[]>;
  /** The focused native window is the web page commands are running against. */
  webWindowFocused(): boolean;
  /** Drop the native dialog target after it has closed. */
  releaseClosedNativeWindow(): Promise<void>;
  /** Process of the app under test. Its window title bar is not the SolidFlow studio window. */
  nativeApp(): { pid: number; appPath: string; hwnd?: string } | null;
  /** Use the web page inside the focused native window when that window is a web view. */
  useWebWindow(selector?: string): Promise<boolean>;
  /** App profile folder, kept across stopApp / relaunch until clearState. */
  profileDir?(): string | undefined;
}

export type LocatorQuery = string;

export interface LocatorResolver {
  resolve(
    page: Page,
    query: LocatorQuery,
    index?: number
  ): Promise<{ locator: import("playwright-core").Locator; match: LocatorMatch }>;
}
