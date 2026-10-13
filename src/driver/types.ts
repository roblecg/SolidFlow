import type { LocatorMatch, DriverKind, DeviceInfo } from "../types.js";
import type { Page } from "playwright-core";

export type DriverContext = {
  appId: string;
  locale: string;
  appPath?: string;
  fixtureUrl?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  userDataDir?: string;
  screenshotDir?: string;
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
  /** Drop the native dialog target after it has closed. */
  releaseClosedNativeWindow(): Promise<void>;
  /** Process of the app under test. Its window title bar is not the SolidFlow studio window. */
  nativeApp(): { pid: number; appPath: string; hwnd?: string } | null;
  /** Use the web page inside the focused native window when that window is a web view. */
  useWebWindow(selector?: string): Promise<boolean>;
  /** WebView2 profile folder, kept across stopApp / relaunch until clearState. */
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
