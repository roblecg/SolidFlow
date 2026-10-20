import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "playwright-core";
import type { DriverKind, DeviceInfo } from "../types.js";
import type { DriverContext } from "./types.js";
import { revealNativeWindow, stopNativeFrameHost } from "./native-frame.js";
import { PlaywrightBaseDriver } from "./playwright-base.js";
import { getFreePort } from "../util/port.js";
import {
  electronExitMessage,
  electronLaunchArgs,
  electronWindowTimeoutMessage,
  isAppPageUrl
} from "./electron-app.js";

const execFileAsync = promisify(execFile);

type CdpTarget = { type?: string; url?: string };

export class ElectronDriver extends PlaywrightBaseDriver {
  readonly kind: DriverKind = "electron";
  private child: ChildProcess | null = null;
  private debugPort = 0;
  private userDataDir = "";
  private ready = false;
  private exitReason: string | null = null;

  async connect(ctx: DriverContext): Promise<void> {
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
      const wsUrl = await this.waitUntilReady(this.debugPort, 90_000);
      await this.connectOverCdp(wsUrl);
      this.preferAppPage();
      this.ready = true;
      await this.getPage().waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
      await this.revealMainWindow();
      await this.rememberNativePopups();
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.stopProcess();
    stopNativeFrameHost();
    // Electron ignores Playwright's close while a window refuses to close, which leaves the CDP socket open.
    const browser = this.browser as { _connection?: { close: (cause?: string) => void } } | null;
    browser?._connection?.close("solidFlow disconnect");
    await Promise.race([
      super.disconnect().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 1_000))
    ]);
  }

  async clearState(): Promise<void> {
    if (this.userDataDir) {
      await this.disconnect();
      await rm(this.userDataDir, { recursive: true, force: true });
      this.userDataDir = await mkdtemp(join(tmpdir(), "solidFlow-electron-"));
      if (this.ctx) this.ctx.userDataDir = this.userDataDir;
    }
  }

  getDeviceInfo(): DeviceInfo {
    const base = super.getDeviceInfo();
    return { ...base, debugPort: this.debugPort, appPath: this.ctx?.appPath };
  }

  nativeApp(): { pid: number; appPath: string; hwnd?: string } | null {
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

  private async revealMainWindow(): Promise<void> {
    const appPath = this.ctx?.appPath;
    const pid = this.child?.pid ?? 0;
    if (!appPath || !pid) return;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (this.exitReason) return;
      if (await revealNativeWindow({ pid, appPath })) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  private preferAppPage(): void {
    const preferred = this.openPages().find(page => isAppPageUrl(page.url()));
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

  private async waitUntilReady(port: number, timeoutMs: number): Promise<string> {
    const started = Date.now();
    let wsUrl = "";
    while (Date.now() - started < timeoutMs) {
      if (this.exitReason) throw new Error(this.exitReason);
      if (!wsUrl) wsUrl = await this.readDebuggerUrl(port);
      if (wsUrl && (await this.hasAppPage(port))) return wsUrl;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (this.exitReason) throw new Error(this.exitReason);
    if (!wsUrl) throw new Error(`CDP did not become ready on port ${port}`);
    const appPath = this.ctx?.appPath ?? "";
    throw new Error(electronWindowTimeoutMessage(appPath, port));
  }

  private async readDebuggerUrl(port: number): Promise<string> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (!res.ok) return "";
      const json = (await res.json()) as { webSocketDebuggerUrl?: string };
      return json.webSocketDebuggerUrl ?? "";
    } catch {
      return "";
    }
  }

  private async hasAppPage(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!res.ok) return false;
      const list = (await res.json()) as CdpTarget[];
      return list.some(target => target.type === "page" && isAppPageUrl(target.url ?? ""));
    } catch {
      return false;
    }
  }

  private async stopProcess(): Promise<void> {
    const child = this.child;
    this.child = null;
    const pid = child?.pid;
    if (!child || !pid) return;
    const exited = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
    }
    try {
      child.kill();
    } catch {
      // already gone
    }
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 3_000))]);
  }
}
