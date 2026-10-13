import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { FlowError, type DeviceInfo, type DriverKind } from "../types.js";
import type { AutomationDriver, DriverContext } from "./types.js";
import { defaultLocatorResolver } from "./locator.js";
import { chooseNativePopup, isClassicDialog, listNativePopups, type NativePopup } from "./native-frame.js";
import { localeInitScript } from "./locale-init.js";
import os from "node:os";

export abstract class PlaywrightBaseDriver implements AutomationDriver {
  abstract readonly kind: DriverKind;
  protected browser: Browser | null = null;
  protected page: Page | null = null;
  protected ctx: DriverContext | null = null;
  private mainPage: Page | null = null;
  private readonly adoptedPages = new Set<Page>();
  protected focusedNativeWindow: NativePopup | null = null;
  private nativePopupBaseline = new Set<string>();
  private readonly adoptedNativePopups = new Set<string>();

  abstract connect(ctx: DriverContext): Promise<void>;

  getPage(): Page {
    if (!this.page) throw new Error("Driver not connected");
    return this.page;
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
    }
    this.browser = null;
    this.page = null;
    this.mainPage = null;
    this.adoptedPages.clear();
    this.focusedNativeWindow = null;
    this.nativePopupBaseline.clear();
    this.adoptedNativePopups.clear();
  }

  async waitForPopup(timeoutMs: number): Promise<void> {
    if (!this.browser || !this.page) {
      throw new FlowError("Connect the app before waiting for a window.");
    }
    const native = this.nativeApp();
    if (native && process.platform === "win32") {
      const open = await listNativePopups({ pid: native.pid, appPath: native.appPath }).catch(() => null);
      if (open) this.forgetHiddenPopups(open);
    }
    const seenPages = new Set(this.adoptedPages);
    const pending: Page[] = [];
    const onPage = (page: Page) => pending.push(page);
    const listening = new Set<BrowserContext>();
    const attach = () => {
      if (!this.browser) return;
      for (const context of this.browser.contexts()) {
        if (listening.has(context)) continue;
        context.on("page", onPage);
        listening.add(context);
      }
    };
    attach();
    const started = Date.now();
    let heldNative: NativePopup | null = null;
    let heldSince = 0;
    try {
      while (Date.now() - started < timeoutMs) {
        attach();
        const page =
          pending.find(item => !item.isClosed() && !seenPages.has(item)) ??
          this.listOpenPages().find(item => !seenPages.has(item));
        if (page) {
          await this.adoptPage(page, timeoutMs, started);
          return;
        }
        if (native && process.platform === "win32") {
          const windows = await listNativePopups({ pid: native.pid, appPath: native.appPath }).catch(() => []);
          const popup = chooseNativePopup(windows, this.nativePopupBaseline, this.adoptedNativePopups);
          if (popup && isClassicDialog(popup)) {
            this.focusNativePopup(popup);
            return;
          }
          if (popup) {
            const web = await this.pageMatchingTitle(popup.title);
            if (web) {
              this.adoptedNativePopups.add(popup.hwnd);
              await this.adoptPage(web, timeoutMs, started);
              return;
            }
            if (!heldNative || heldNative.hwnd !== popup.hwnd) {
              heldNative = popup;
              heldSince = Date.now();
            } else if (Date.now() - heldSince >= Math.min(8_000, timeoutMs)) {
              this.focusNativePopup(popup);
              return;
            }
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (heldNative) {
        this.focusNativePopup(heldNative);
        return;
      }
    } finally {
      for (const context of listening) context.off("page", onPage);
    }
    throw new FlowError(
      "No new window appeared in the connected app. A folder picker or other window of that app counts. A separate system browser does not."
    );
  }

  async useWebWindow(selector?: string): Promise<boolean> {
    const focused = this.focusedNativeWindow;
    if (!focused || isClassicDialog(focused)) return false;
    const page =
      (await this.pageMatchingTitle(focused.title)) ?? (selector ? await this.pageContaining(selector) : null);
    if (!page) return false;
    this.focusedNativeWindow = null;
    this.page = page;
    this.adoptedPages.add(page);
    await page.bringToFront().catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    return true;
  }

  async switchToMain(): Promise<void> {
    this.focusedNativeWindow = null;
    if (!this.mainPage || this.mainPage.isClosed()) {
      throw new FlowError("The original window is no longer open.");
    }
    this.page = this.mainPage;
    await this.mainPage.bringToFront().catch(() => {});
  }

  async releaseClosedNativeWindow(): Promise<void> {
    const current = this.focusedNativeWindow;
    if (!current) return;
    const native = this.nativeApp();
    if (!native) {
      this.focusedNativeWindow = null;
      return;
    }
    const open = await listNativePopups({ pid: native.pid, appPath: native.appPath }).catch(() => null);
    if (!open) return;
    if (!open.some(window => window.hwnd === current.hwnd)) this.focusedNativeWindow = null;
  }

  protected async rememberNativePopups(): Promise<void> {
    const native = this.nativeApp();
    if (!native || process.platform !== "win32") return;
    const windows = await listNativePopups({ pid: native.pid, appPath: native.appPath }).catch(() => []);
    this.nativePopupBaseline = new Set(windows.map(window => window.hwnd));
  }

  async clearState(): Promise<void> {
    const page = this.getPage();
    await page.context().clearCookies();
    await page.evaluate("localStorage.clear(); sessionStorage.clear();");
  }

  getDeviceInfo(): DeviceInfo {
    return {
      platform: `${os.type()} ${os.release()}`,
      hostname: os.hostname(),
      driver: this.kind,
      appPath: this.ctx?.appPath
    };
  }

  nativeApp(): { pid: number; appPath: string; hwnd?: string } | null {
    return null;
  }

  async takeScreenshot(name: string): Promise<string> {
    const page = this.getPage();
    const dir = this.ctx?.screenshotDir ?? join(process.cwd(), "test-results", "screenshots");
    await mkdir(dir, { recursive: true });
    const safe = name.replace(/[^\w.-]+/g, "_");
    const path = join(dir, `${safe}.png`);
    await page.screenshot({ path, fullPage: true });
    return path;
  }

  protected async launchChromium(headless: boolean, url?: string): Promise<void> {
    this.browser = await chromium.launch({ headless });
    const context = await this.browser.newContext({
      viewport: this.ctx?.viewport ?? { width: 1280, height: 720 }
    });
    if (this.ctx?.locale) {
      await context.addInitScript(localeInitScript(this.ctx.locale));
    }
    this.page = await context.newPage();
    if (url) {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
    }
    this.rememberMainPage();
  }

  protected async connectOverCdp(endpoint: string): Promise<void> {
    this.browser = await chromium.connectOverCDP(endpoint);
    const context = this.browser.contexts()[0];
    if (!context) {
      throw new Error("CDP browser has no context");
    }
    if (this.ctx?.locale) {
      await context.addInitScript(localeInitScript(this.ctx.locale));
    }
    this.page = context.pages()[0] ?? (await context.newPage());
    this.rememberMainPage();
  }

  private rememberMainPage(): void {
    if (!this.page) return;
    this.mainPage = this.page;
    this.adoptedPages.clear();
    this.adoptedPages.add(this.page);
  }

  private focusNativePopup(popup: NativePopup): void {
    this.focusedNativeWindow = popup;
    this.adoptedNativePopups.add(popup.hwnd);
  }

  private async adoptPage(page: Page, timeoutMs: number, started: number): Promise<void> {
    this.focusedNativeWindow = null;
    this.page = page;
    this.adoptedPages.add(page);
    await page.bringToFront().catch(() => {});
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    await page.waitForLoadState("domcontentloaded", { timeout: remaining }).catch(() => {});
    await this.adoptWindowsTitled(page);
  }

  /** The native window that hosts an adopted page must not be reported as the next new window. */
  private async adoptWindowsTitled(page: Page): Promise<void> {
    const native = this.nativeApp();
    if (!native || process.platform !== "win32") return;
    const title = (await page.title().catch(() => "")).trim();
    if (!title) return;
    const windows = await listNativePopups({ pid: native.pid, appPath: native.appPath }).catch(() => []);
    for (const window of windows) {
      if (window.title.trim() === title && !isClassicDialog(window)) this.adoptedNativePopups.add(window.hwnd);
    }
  }

  /** A window that was hidden and shown again keeps its handle, so it counts as new next time. */
  private forgetHiddenPopups(open: NativePopup[]): void {
    const visible = new Set(open.map(window => window.hwnd));
    for (const hwnd of [...this.adoptedNativePopups]) {
      if (!visible.has(hwnd)) this.adoptedNativePopups.delete(hwnd);
    }
    for (const hwnd of [...this.nativePopupBaseline]) {
      if (!visible.has(hwnd)) this.nativePopupBaseline.delete(hwnd);
    }
  }

  private async pageContaining(selector: string): Promise<Page | null> {
    for (const page of this.listOpenPages()) {
      if (page === this.mainPage) continue;
      try {
        await defaultLocatorResolver.resolve(page, selector);
        return page;
      } catch {
        // This page does not have the control yet.
      }
    }
    return null;
  }

  private async pageMatchingTitle(title: string): Promise<Page | null> {
    const wanted = title.trim();
    if (!wanted) return null;
    for (const page of this.listOpenPages()) {
      if (page === this.mainPage) continue;
      const current = (await page.title().catch(() => "")).trim();
      if (current === wanted) return page;
    }
    return null;
  }

  private listOpenPages(): Page[] {
    if (!this.browser) return [];
    const pages: Page[] = [];
    for (const context of this.browser.contexts()) {
      for (const page of context.pages()) {
        if (!page.isClosed()) pages.push(page);
      }
    }
    return pages;
  }

  protected async waitForCdpEndpoint(
    port: number,
    timeoutMs = 60_000
  ): Promise<string> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) {
          const json = (await res.json()) as { webSocketDebuggerUrl?: string };
          if (json.webSocketDebuggerUrl) {
            return json.webSocketDebuggerUrl;
          }
        }
      } catch {
        // retry
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`CDP did not become ready on port ${port}`);
  }
}
