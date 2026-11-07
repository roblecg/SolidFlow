import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { FlowError, RunStoppedError, type DeviceInfo, type DriverKind } from "../types.js";
import type { AutomationDriver, DriverContext } from "./types.js";
import { defaultLocatorResolver } from "./locator.js";
import {
  chooseNativePopup,
  chooseOpenedBrowserPage,
  focusSystemBrowser,
  isClassicDialog,
  listNativePopups,
  readSystemBrowserUrl,
  readSystemBrowsers,
  type NativeApp,
  type NativePopup,
  type SystemBrowserPage
} from "./native-frame.js";
import { isAppPageUrl, isKcpsDesktop, isKcpsMainPageUrl } from "./electron-app.js";
import { localeInitScript } from "./locale-init.js";
import {
  describeWindowQuery,
  hwndForBounds,
  outerBounds,
  pageFileName,
  urlMatchesFile,
  type SwitchWindowChoice,
  type WindowQuery
} from "./window-target.js";
import os from "node:os";
import type { Page } from "playwright-core";

export abstract class PlaywrightBaseDriver implements AutomationDriver {
  abstract readonly kind: DriverKind;
  protected browser: Browser | null = null;
  /** System browser the app opened. Commands use that window until switchToMain. */
  private externalNative: NativeApp | null = null;
  /** Addresses showing before the app opened a browser page. */
  private browserBaseline: SystemBrowserPage[] | null = null;
  protected page: Page | null = null;
  protected ctx: DriverContext | null = null;
  private mainPage: Page | null = null;
  private readonly adoptedPages = new Set<Page>();
  protected focusedNativeWindow: NativePopup | null = null;
  /** The focused native window is showing the current web page, so taps stay on that page. */
  private webWindow = false;
  private nativePopupBaseline = new Set<string>();
  private readonly adoptedNativePopups = new Set<string>();
  /** Electron does not implement Browser.getWindowForTarget. Remember that and read the page size instead. */
  private browserBoundsUnsupported = false;

  abstract connect(ctx: DriverContext): Promise<void>;

  getPage(): Page {
    if (!this.page) throw new Error("Driver not connected");
    return this.page;
  }

  async disconnect(): Promise<void> {
    const browser = this.browser;
    this.clearAttachedBrowser();
    if (browser) await browser.close().catch(() => {});
  }

  /**
   * Forget this app's browser after its process is gone.
   * browser.close() only. Closing browser._connection shuts Playwright down for the whole
   * Studio process, and the next connect fails with "solidFlow disconnect".
   */
  protected async releaseBrowser(): Promise<void> {
    const browser = this.browser;
    this.clearAttachedBrowser();
    if (!browser) return;
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 2_000))
    ]);
  }

  private clearAttachedBrowser(): void {
    this.browser = null;
    this.page = null;
    this.mainPage = null;
    this.adoptedPages.clear();
    this.clearFocusedWindow();
    this.browserBaseline = null;
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
          pending.find(item => unseenAppPage(item, seenPages)) ??
          this.listOpenPages().find(item => unseenAppPage(item, seenPages));
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
    if (this.externalNative) return false;
    const focused = this.focusedNativeWindow;
    if (!focused || isClassicDialog(focused)) return false;
    const page =
      (await this.pageMatchingTitle(focused.title)) ?? (selector ? await this.pageContaining(selector) : null);
    if (!page) return false;
    this.clearFocusedWindow();
    this.page = page;
    this.adoptedPages.add(page);
    await page.bringToFront().catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    return true;
  }

  async switchToMain(): Promise<void> {
    this.clearFocusedWindow();
    if (!this.mainPage || this.mainPage.isClosed()) {
      throw new FlowError("The original window is no longer open.");
    }
    this.page = this.mainPage;
    await this.mainPage.bringToFront().catch(() => {});
  }

  /**
   * The app opened a page in the system browser. Later tapOn, inputText, and assertVisible
   * use that window, so the account already signed in to Windows stays available.
   * An empty address uses the page that appeared since the previous step.
   */
  async switchToBrowser(urlPart: string, timeoutMs: number): Promise<void> {
    const needle = urlPart.trim();
    if (process.platform !== "win32") {
      throw new FlowError("switchToBrowser follows the system browser on Windows.");
    }
    if (!this.page) throw new FlowError("Connect the app before switching to the browser.");
    if (!this.mainPage || this.mainPage.isClosed()) this.rememberMainPage();
    const target = needle ? await this.waitForBrowserUrl(needle, timeoutMs) : await this.waitForOpenedBrowser(timeoutMs);
    if (!target) {
      throw new FlowError(
        needle
          ? `No browser page matched "${needle}". The app has to open that address in the system browser first.`
          : "The app has not opened a page in the system browser."
      );
    }
    const snap = await readSystemBrowsers();
    if (snap) this.browserBaseline = snap.pages;
    this.clearFocusedWindow();
    this.externalNative = { pid: target.pid, appPath: target.appPath, hwnd: target.hwnd };
    this.focusedNativeWindow = { hwnd: target.hwnd, title: "" };
    await focusSystemBrowser(this.externalNative);
  }

  hasBrowserBaseline(): boolean {
    return this.browserBaseline !== null;
  }

  /** Remember the browser pages now, unless the one switchToBrowser is waiting for is already open. */
  async noteSystemBrowser(beforeSwitch: boolean): Promise<void> {
    if (process.platform !== "win32") return;
    const snap = await readSystemBrowsers();
    if (!snap) return;
    if (
      beforeSwitch &&
      snap.browser &&
      this.browserBaseline &&
      chooseOpenedBrowserPage(this.browserBaseline, snap.pages, snap.foreground, "")
    ) {
      return;
    }
    this.browserBaseline = snap.pages;
  }

  private async waitForBrowserUrl(needle: string, timeoutMs: number): Promise<SystemBrowserPage | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const target = await readSystemBrowserUrl(needle);
      if (target) return target;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return null;
  }

  private async waitForOpenedBrowser(timeoutMs: number): Promise<SystemBrowserPage | null> {
    let before = this.browserBaseline;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const snap = await readSystemBrowsers();
      if (!snap) {
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }
      if (!before) {
        before = snap.pages;
        this.browserBaseline = snap.pages;
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }
      const opened = chooseOpenedBrowserPage(before, snap.pages, snap.foreground, "");
      if (opened) return opened;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return null;
  }

  /** The browser window commands are using, when switchToBrowser is active. */
  protected externalApp(): NativeApp | null {
    return this.externalNative;
  }

  webWindowFocused(): boolean {
    return this.webWindow;
  }

  /**
   * Select a window by page file, caption, or heading.
   * The original window stays remembered for switchToMain.
   * This window counts as already seen, so waitForPopup still waits for a later one.
   */
  async switchToWindow(query: WindowQuery, timeoutMs: number): Promise<void> {
    if (!this.browser || !this.page) {
      throw new FlowError("Connect the app before switching windows.");
    }
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = await this.findSwitchTarget(query);
      if (found.kind === "many") {
        throw new FlowError(
          `More than one window matches ${describeWindowQuery(query)}. Use file: with the page name, such as ProxySettings.html.`
        );
      }
      if (found.kind === "web") {
        this.externalNative = null;
        await this.useSwitchedPage(found.page, found.hwnd);
        return;
      }
      if (found.kind === "native") {
        this.externalNative = null;
        this.focusedNativeWindow = found.hwnd;
        this.webWindow = false;
        this.adoptedNativePopups.add(found.hwnd.hwnd);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new FlowError(
      `No open window matched ${describeWindowQuery(query)}. The window has to be visible in the connected app.`
    );
  }

  /** Visible app windows, one entry per file name. A hidden page is omitted until it is shown. */
  async listSwitchWindows(): Promise<SwitchWindowChoice[]> {
    const native = this.nativeApp();
    const windows =
      native && process.platform === "win32"
        ? await listNativePopups({ pid: native.pid, appPath: native.appPath }).catch(() => [])
        : [];
    const seen = new Map<string, SwitchWindowChoice>();
    for (const page of this.listOpenPages()) {
      let url = "";
      try {
        url = page.url();
      } catch {
        continue;
      }
      if (!isAppPageUrl(url)) continue;
      const file = pageFileName(url);
      if (!file) continue;
      const key = file.toLowerCase();
      if (seen.has(key)) continue;
      let visible = false;
      try {
        visible = (await this.readyWebTarget(page, windows)).kind === "web";
      } catch {
        visible = false;
      }
      if (!visible) continue;
      seen.set(key, { file, label: await this.switchWindowLabel(page, file) });
    }
    return [...seen.values()].sort((a, b) => a.file.localeCompare(b.file));
  }

  async releaseClosedNativeWindow(): Promise<void> {
    if (this.externalNative) return;
    const current = this.focusedNativeWindow;
    if (!current) return;
    const native = this.nativeApp();
    if (!native) {
      this.clearFocusedWindow();
      return;
    }
    const open = await listNativePopups({ pid: native.pid, appPath: native.appPath }).catch(() => null);
    if (!open) return;
    if (!open.some(window => window.hwnd === current.hwnd)) this.clearFocusedWindow();
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
    return this.externalNative;
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
    this.usePage(context.pages()[0] ?? (await context.newPage()));
  }

  protected usePage(page: Page): void {
    this.page = page;
    this.rememberMainPage();
  }

  private rememberMainPage(): void {
    if (!this.page) return;
    this.mainPage = this.page;
    this.adoptedPages.clear();
    // Pages already open belong to the app as it is now. waitForPopup follows one that opens afterward.
    this.adoptOpenPages();
  }

  /** Remember every page that exists so a hidden dialog is not treated as the next new window. */
  protected adoptOpenPages(): void {
    for (const page of this.listOpenPages()) this.adoptedPages.add(page);
  }

  private focusNativePopup(popup: NativePopup): void {
    this.externalNative = null;
    this.focusedNativeWindow = popup;
    this.webWindow = false;
    this.adoptedNativePopups.add(popup.hwnd);
  }

  private clearFocusedWindow(): void {
    this.focusedNativeWindow = null;
    this.webWindow = false;
    this.externalNative = null;
  }

  /** Point commands at this page. waitForPopup still treats the page as new until it adopts it itself. */
  private async useSwitchedPage(page: Page, hwnd: NativePopup | null): Promise<void> {
    this.externalNative = null;
    this.page = page;
    this.adoptedPages.add(page);
    if (hwnd && !isClassicDialog(hwnd)) {
      this.focusedNativeWindow = hwnd;
      this.webWindow = true;
      this.adoptedNativePopups.add(hwnd.hwnd);
    } else {
      this.clearFocusedWindow();
    }
    await page.bringToFront().catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  }

  private async findSwitchTarget(
    query: WindowQuery
  ): Promise<
    | { kind: "none" }
    | { kind: "many" }
    | { kind: "web"; page: Page; hwnd: NativePopup | null }
    | { kind: "native"; hwnd: NativePopup }
  > {
    const pages = this.listOpenPages().filter(page => isAppPageUrl(page.url()));
    const native = this.nativeApp();
    const windows =
      native && process.platform === "win32"
        ? await listNativePopups({ pid: native.pid, appPath: native.appPath }).catch(() => [])
        : [];
    const matched: Page[] = [];
    for (const page of pages) {
      if (await this.pageMatchesQuery(page, query, windows)) matched.push(page);
    }
    if (matched.length === 0 && (query.any || !query.file)) {
      const byTitle = await this.pagesForNativeTitle(pages, windows, query);
      if (byTitle.kind !== "pages") return byTitle;
      matched.push(...byTitle.pages);
    }
    if (matched.length > 1) return { kind: "many" };
    if (matched.length === 0) return { kind: "none" };
    return this.readyWebTarget(matched[0]!, windows);
  }

  private async readyWebTarget(
    page: Page,
    windows: NativePopup[]
  ): Promise<{ kind: "none" } | { kind: "web"; page: Page; hwnd: NativePopup | null }> {
    const kcps = Boolean(this.ctx?.appPath && isKcpsDesktop(this.ctx.appPath));
    const mainFile = kcps && isKcpsMainPageUrl(page.url());
    const needsHwnd = Boolean(this.nativeApp()) && process.platform === "win32" && !mainFile && page !== this.mainPage;
    if (!needsHwnd) return { kind: "web", page, hwnd: null };
    const hwnd = await this.hwndForPage(page, windows);
    if (!hwnd || isClassicDialog(hwnd)) return { kind: "none" };
    return { kind: "web", page, hwnd };
  }

  private async pagesForNativeTitle(
    pages: Page[],
    windows: NativePopup[],
    query: WindowQuery
  ): Promise<
    | { kind: "none" }
    | { kind: "many" }
    | { kind: "native"; hwnd: NativePopup }
    | { kind: "pages"; pages: Page[] }
  > {
    const wanted = query.title?.trim() ?? "";
    if (!wanted) return { kind: "none" };
    const webWindows = windows.filter(window => window.title.trim() === wanted && !isClassicDialog(window));
    const found: Page[] = [];
    for (const window of webWindows) {
      const page = await this.pageMatchingBounds(pages, window);
      if (page && !found.includes(page)) found.push(page);
    }
    if (found.length > 1) return { kind: "many" };
    if (found.length === 1) return { kind: "pages", pages: found };
    if (webWindows.length > 0) return { kind: "none" };
    const classic = windows.filter(window => window.title.trim() === wanted && isClassicDialog(window));
    if (classic.length > 1) return { kind: "many" };
    if (classic.length === 1) return { kind: "native", hwnd: classic[0]! };
    return { kind: "none" };
  }

  private async pageMatchesQuery(page: Page, query: WindowQuery, windows: NativePopup[]): Promise<boolean> {
    if (query.any) {
      if (query.file && urlMatchesFile(page.url(), query.file)) return true;
      if (query.title && (await this.captionMatches(page, query.title, windows))) return true;
      if (query.text && (await pageHasVisibleText(page, query.text))) return true;
      return false;
    }
    if (query.file && !urlMatchesFile(page.url(), query.file)) return false;
    if (query.title && !(await this.captionMatches(page, query.title, windows))) return false;
    if (query.text && !(await pageHasVisibleText(page, query.text))) return false;
    return Boolean(query.file || query.title || query.text);
  }

  /** A caption is the document title, or the native window title when the page leaves the document title empty. */
  private async captionMatches(page: Page, title: string, windows: NativePopup[]): Promise<boolean> {
    const wanted = title.trim();
    if ((await page.title().catch(() => "")).trim() === wanted) return true;
    if (windows.length === 0) return false;
    const hwnd = await this.hwndForPage(page, windows);
    return hwnd?.title.trim() === wanted;
  }

  private async pageMatchingBounds(pages: Page[], window: NativePopup): Promise<Page | null> {
    for (const page of pages) {
      if (page === this.mainPage) continue;
      if (this.ctx?.appPath && isKcpsDesktop(this.ctx.appPath) && isKcpsMainPageUrl(page.url())) continue;
      const hwnd = await this.hwndForPage(page, [window]);
      if (hwnd) return page;
    }
    return null;
  }

  private async hwndForPage(page: Page, windows: NativePopup[]): Promise<NativePopup | null> {
    if (windows.length === 0) return null;
    const bounds = await this.cdpWindowBounds(page);
    if (!bounds) return null;
    const hwnd = hwndForBounds(bounds, windows);
    if (!hwnd) return null;
    return windows.find(window => window.hwnd === hwnd) ?? null;
  }

  private async cdpWindowBounds(
    page: Page
  ): Promise<{ left: number; top: number; width: number; height: number } | null> {
    const fromBrowser = await this.browserWindowBounds(page);
    if (fromBrowser) return fromBrowser;
    return this.pageOuterBounds(page);
  }

  private async browserWindowBounds(
    page: Page
  ): Promise<{ left: number; top: number; width: number; height: number } | null> {
    if (this.browserBoundsUnsupported) return null;
    try {
      const session = await page.context().newCDPSession(page);
      try {
        const result = await session.send("Browser.getWindowForTarget");
        const bounds = result.bounds;
        if (!bounds || typeof bounds.width !== "number" || typeof bounds.height !== "number") return null;
        if (bounds.width < 1 || bounds.height < 1) return null;
        return {
          left: typeof bounds.left === "number" ? bounds.left : 0,
          top: typeof bounds.top === "number" ? bounds.top : 0,
          width: bounds.width,
          height: bounds.height
        };
      } finally {
        await session.detach().catch(() => {});
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("wasn't found") || message.includes("not found")) this.browserBoundsUnsupported = true;
      return null;
    }
  }

  /** The same rectangle Win32 reports for an Electron window: outer size and screen position. */
  private async pageOuterBounds(
    page: Page
  ): Promise<{ left: number; top: number; width: number; height: number } | null> {
    try {
      const value = await page.evaluate(`(() => ({
        left: window.screenX,
        top: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight
      }))()`);
      return outerBounds(value);
    } catch {
      return null;
    }
  }

  private async adoptPage(page: Page, timeoutMs: number, started: number): Promise<void> {
    this.clearFocusedWindow();
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

  private async switchWindowLabel(page: Page, file: string): Promise<string> {
    const title = (await page.title().catch(() => "")).trim();
    if (title && title.toLowerCase() !== file.toLowerCase()) return title;
    const heading = await this.pageHeading(page);
    if (heading && heading.toLowerCase() !== file.toLowerCase()) return heading;
    return "";
  }

  private async pageHeading(page: Page): Promise<string> {
    try {
      const value = await Promise.race([
        page.evaluate(`(() => {
          const node = document.querySelector("#title, h1, h2, [role='heading']");
          const text = node && (node.innerText || node.textContent) ? (node.innerText || node.textContent) : "";
          return String(text).trim().split("\\n")[0].trim();
        })()`).catch(() => ""),
        new Promise<string>(resolve => setTimeout(() => resolve(""), 400))
      ]);
      return typeof value === "string" ? value.trim() : "";
    } catch {
      return "";
    }
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

  /** Empty when `ended` reports the launched app is gone. */
  protected async waitForCdpEndpoint(
    port: number,
    timeoutMs = 60_000,
    until: { signal?: AbortSignal; ended?: () => boolean } = {}
  ): Promise<string> {
    const started = Date.now();
    let timeouts = 0;
    while (Date.now() - started < timeoutMs) {
      if (until.signal?.aborted) throw new RunStoppedError();
      if (until.ended?.()) return "";
      const version = await readCdpJson<{ webSocketDebuggerUrl?: string }>(port, "/json/version", until.signal);
      if (version.value?.webSocketDebuggerUrl) return version.value.webSocketDebuggerUrl;
      timeouts = version.timedOut ? timeouts + 1 : 0;
      if (cdpProbeBlocked(timeouts)) throw new Error(cdpBlockedMessage(port));
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`CDP did not become ready on port ${port}`);
  }
}

const CDP_PROBE_MS = 2_000;
/** A port that is still opening refuses at once, so probes that keep timing out mean the connection is blocked. */
const CDP_BLOCKED_PROBES = 8;

export async function readCdpJson<T>(
  port: number,
  path: string,
  signal?: AbortSignal
): Promise<{ value: T | null; timedOut: boolean }> {
  const timeout = AbortSignal.timeout(CDP_PROBE_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!res.ok) return { value: null, timedOut: false };
    return { value: (await res.json()) as T, timedOut: false };
  } catch (err) {
    const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
    return { value: null, timedOut: timeout.aborted || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" };
  }
}

export function cdpProbeBlocked(timeouts: number): boolean {
  return timeouts >= CDP_BLOCKED_PROBES;
}

export function cdpBlockedMessage(port: number): string {
  return (
    `The app opened debugging port ${port}, but every connection to it times out. ` +
    "Security software on this PC is blocking Chromium debugging ports. " +
    "Ask IT to allow local connections to the app's debugging port, then connect again."
  );
}

/** The element's own text, so a heading matches without also matching the paragraph under it. */
function unseenAppPage(page: Page, seen: Set<Page>): boolean {
  if (page.isClosed() || seen.has(page)) return false;
  try {
    const url = page.url();
    // about:blank stays eligible: a script can open a window and write into it.
    return !url.startsWith("devtools://") && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://");
  } catch {
    return false;
  }
}

async function pageHasVisibleText(page: Page, text: string): Promise<boolean> {
  const wanted = text.trim();
  if (!wanted) return false;
  try {
    return await page.evaluate(needle => {
      if (!document.body) return false;
      const elements = document.body.querySelectorAll("*");
      for (let index = 0; index < elements.length; index += 1) {
        const el = elements[index];
        if (!el || el.closest("[hidden]")) continue;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
        if (el.getClientRects().length === 0) continue;
        let own = "";
        for (let child = 0; child < el.childNodes.length; child += 1) {
          const node = el.childNodes[child];
          if (node && node.nodeType === Node.TEXT_NODE) own += node.textContent ?? "";
        }
        if (own.replace(/\s+/g, " ").trim() === needle) return true;
      }
      return false;
    }, wanted);
  } catch {
    return false;
  }
}
