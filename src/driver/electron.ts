import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "playwright-core";
import { RunStoppedError, type DriverKind, type DeviceInfo } from "../types.js";
import type { DriverContext } from "./types.js";
import { revealNativeWindow, stopNativeFrameHost } from "./native-frame.js";
import { cdpBlockedMessage, cdpProbeBlocked, PlaywrightBaseDriver, readCdpJson } from "./playwright-base.js";
import { stopLaunchedApp } from "./stop-app.js";
import { getFreePort } from "../util/port.js";
import {
  electronAttachError,
  electronExitMessage,
  electronLaunchArgs,
  electronWindowTimeoutMessage,
  isAppPageUrl,
  isKcpsDesktop,
  preferKcpsPageUrl
} from "./electron-app.js";

type CdpTarget = { type?: string; url?: string };

export class ElectronDriver extends PlaywrightBaseDriver {
  readonly kind: DriverKind = "electron";
  private child: ChildProcess | null = null;
  private debugPort = 0;
  private userDataDir = "";
  private ready = false;
  private stopped = false;
  private exitReason: string | null = null;

  async connect(ctx: DriverContext): Promise<void> {
    this.stopped = false;
    this.ctx = ctx;
    if (!ctx.appPath) {
      throw new Error("Electron driver requires appPath on the flow (or SOLIDFLOW_APP_PATH).");
    }
    this.ready = false;
    this.exitReason = null;
    this.debugPort = await getFreePort();
    this.userDataDir = ctx.userDataDir ?? (await mkdtemp(join(tmpdir(), "solidFlow-electron-")));
    ctx.userDataDir = this.userDataDir;

    const appPath = ctx.appPath;
    if (this.stopped || ctx.signal?.aborted) throw new RunStoppedError();
    this.child = spawn(appPath, electronLaunchArgs(this.debugPort, this.userDataDir), {
      cwd: dirname(appPath),
      stdio: "ignore",
      windowsHide: true
    });
    this.child.on("error", err => {
      if (!this.ready) this.exitReason = `Could not start Electron app: ${err.message}`;
    });
    this.child.on("exit", (code, signal) => {
      if (!this.ready) this.exitReason = electronExitMessage(appPath, code, signal);
    });

    try {
      const wsUrl = await this.waitUntilReady(this.debugPort, 90_000, ctx.signal);
      await this.connectOverCdp(wsUrl);
      this.preferAppPage();
      this.ready = true;
      await this.getPage().waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
      await this.revealMainWindow(ctx.signal);
      await this.rememberNativePopups();
      this.adoptOpenPages();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.disconnect().catch(() => {});
      const closed = electronAttachError(message);
      if (closed) throw new Error(closed);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.stopProcess();
    stopNativeFrameHost();
    await this.releaseBrowser();
  }

  async clearState(): Promise<void> {
    if (this.userDataDir) {
      await this.disconnect();
      await rm(this.userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      this.userDataDir = await mkdtemp(join(tmpdir(), "solidFlow-electron-"));
      if (this.ctx) this.ctx.userDataDir = this.userDataDir;
    }
  }

  getDeviceInfo(): DeviceInfo {
    const base = super.getDeviceInfo();
    return { ...base, debugPort: this.debugPort, appPath: this.ctx?.appPath };
  }

  nativeApp(): { pid: number; appPath: string; hwnd?: string } | null {
    const external = this.externalApp();
    if (external) return external;
    const appPath = this.ctx?.appPath;
    if (!appPath) return null;
    return {
      pid: this.child?.pid ?? 0,
      appPath,
      ...(this.focusedNativeWindow ? { hwnd: this.focusedNativeWindow.hwnd } : {})
    };
  }

  profileDir(): string | undefined {
    return this.userDataDir || this.ctx?.userDataDir;
  }

  private async revealMainWindow(signal?: AbortSignal): Promise<void> {
    const appPath = this.ctx?.appPath;
    const pid = this.child?.pid ?? 0;
    if (!appPath || !pid) return;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (this.exitReason || this.stopped) return;
      if (signal?.aborted) throw new RunStoppedError();
      if (await revealNativeWindow({ pid, appPath })) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  private preferAppPage(): void {
    const pages = this.openPages();
    const urls = pages.map(page => page.url());
    const preferredUrl =
      this.ctx?.appPath && isKcpsDesktop(this.ctx.appPath)
        ? preferKcpsPageUrl(urls)
        : urls.find(url => isAppPageUrl(url));
    const preferred = preferredUrl ? pages.find(page => page.url() === preferredUrl) : undefined;
    if (preferred) this.usePage(preferred);
  }

  private openPages(): Page[] {
    if (!this.browser) return [];
    const pages: Page[] = [];
    for (const context of this.browser.contexts()) {
      for (const page of context.pages()) {
        if (!page.isClosed()) pages.push(page);
      }
    }
    return pages;
  }

  private async waitUntilReady(port: number, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const started = Date.now();
    let wsUrl = "";
    let timeouts = 0;
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted || this.stopped) throw new RunStoppedError();
      if (this.exitReason) throw new Error(this.exitReason);
      if (!wsUrl) {
        const version = await readCdpJson<{ webSocketDebuggerUrl?: string }>(port, "/json/version", signal);
        wsUrl = version.value?.webSocketDebuggerUrl ?? "";
        timeouts = version.timedOut ? timeouts + 1 : 0;
        if (cdpProbeBlocked(timeouts)) throw new Error(cdpBlockedMessage(port));
      }
      if (wsUrl && (await this.hasAppPage(port, signal))) return wsUrl;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (this.exitReason) throw new Error(this.exitReason);
    if (!wsUrl) throw new Error(`CDP did not become ready on port ${port}`);
    const appPath = this.ctx?.appPath ?? "";
    throw new Error(electronWindowTimeoutMessage(appPath, port));
  }

  private async hasAppPage(port: number, signal?: AbortSignal): Promise<boolean> {
    const list = await readCdpJson<CdpTarget[]>(port, "/json/list", signal);
    return (list.value ?? []).some(target => target.type === "page" && isAppPageUrl(target.url ?? ""));
  }

  private async stopProcess(): Promise<void> {
    const child = this.child;
    this.child = null;
    const pid = child?.pid;
    const exited = new Promise<void>(resolve => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });
    await stopLaunchedApp({
      pid,
      appPath: this.ctx?.appPath,
      userDataDir: this.userDataDir,
      debugPort: this.debugPort
    });
    try {
      child?.kill();
    } catch {
      // already gone
    }
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 3_000))]);
  }
}
