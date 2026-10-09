import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { FlowError, type DeviceInfo, type DriverKind } from "../types.js";
import type { AutomationDriver, DriverContext } from "./types.js";
import { localeInitScript } from "./locale-init.js";
import os from "node:os";

export abstract class PlaywrightBaseDriver implements AutomationDriver {
  abstract readonly kind: DriverKind;
  protected browser: Browser | null = null;
  protected page: Page | null = null;
  protected ctx: DriverContext | null = null;
  private mainPage: Page | null = null;
  private readonly adoptedPages = new Set<Page>();

  abstract connect(ctx: DriverContext): Promise<void>;

  getPage(): Page {
    if (!this.page) throw new Error("Driver not connected");
    return this.page;
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
      this.mainPage = null;
      this.adoptedPages.clear();
    }
  }

  async waitForPopup(timeoutMs: number): Promise<void> {
    if (!this.browser || !this.page) {
      throw new FlowError("Connect the app before waiting for a window.");
    }
    const found = await this.waitForUnadoptedPage(timeoutMs, new Set(this.adoptedPages));
    if (!found) {
      throw new FlowError(
        "No new WebView or browser window appeared in the connected app. A separate system browser or a native dialog is not part of this session."
      );
    }
    this.page = found;
    this.adoptedPages.add(found);
    await found.bringToFront().catch(() => {});
    await found.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
  }

  async switchToMain(): Promise<void> {
    if (!this.mainPage || this.mainPage.isClosed()) {
      throw new FlowError("The original window is no longer open.");
    }
    this.page = this.mainPage;
    await this.mainPage.bringToFront().catch(() => {});
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

  private async waitForUnadoptedPage(timeoutMs: number, baseline: Set<Page>): Promise<Page | null> {
    const already = this.listOpenPages().find(page => !baseline.has(page));
    if (already) return already;

    const pending: Page[] = [];
    const onPage = (page: Page) => {
      pending.push(page);
    };
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
    try {
      while (Date.now() - started < timeoutMs) {
        attach();
        const popped = pending.find(page => !page.isClosed() && !baseline.has(page));
        if (popped) return popped;
        const scanned = this.listOpenPages().find(page => !baseline.has(page));
        if (scanned) return scanned;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return null;
    } finally {
      for (const context of listening) context.off("page", onPage);
    }
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
