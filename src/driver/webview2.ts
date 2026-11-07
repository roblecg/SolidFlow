import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { RunStoppedError, type DriverKind, type DeviceInfo } from "../types.js";
import type { DriverContext } from "./types.js";
import { stopNativeFrameHost } from "./native-frame.js";
import { PlaywrightBaseDriver } from "./playwright-base.js";
import { launchExit, stopLaunchedApp, type LaunchExit } from "./stop-app.js";
import { getFreePort } from "../util/port.js";
import { kcpsInstallerHint } from "./electron-app.js";

export class WebView2Driver extends PlaywrightBaseDriver {
  readonly kind: DriverKind = "webview2";
  private child: ChildProcess | null = null;
  private debugPort = 0;
  private userDataDir = "";
  private launched = false;

  async connect(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    if (!ctx.appPath) {
      throw new Error("WebView2 driver requires appPath on the flow (or SOLIDFLOW_APP_PATH).");
    }
    const appPath = ctx.appPath;
    const installerHint = kcpsInstallerHint(appPath);
    if (installerHint) throw new Error(installerHint);
    this.launched = true;
    try {
      this.userDataDir =
        ctx.userDataDir ?? (await mkdtemp(join(tmpdir(), "solidFlow-wv2-")));
      ctx.userDataDir = this.userDataDir;

      let wsUrl = await this.launch(appPath, ctx.signal);
      if (!wsUrl) {
        await stopLaunchedApp({ appPath });
        wsUrl = await this.launch(appPath, ctx.signal);
      }
      if (!wsUrl) {
        throw new Error(`${basename(appPath)} is already open and did not close. Close it, then connect again.`);
      }
      await this.connectOverCdp(wsUrl);

      await this.getPage().waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
      await this.rememberNativePopups();
      this.adoptOpenPages();
    } catch (err) {
      await this.disconnect().catch(() => {});
      throw err;
    }
  }

  /**
   * The debugger address of a fresh launch. Empty when the exe handed the launch to
   * a copy that was already open, since a single-instance app closes and that copy has no debugging port.
   */
  private async launch(appPath: string, signal?: AbortSignal): Promise<string> {
    const port = await getFreePort();
    if (!this.launched || signal?.aborted) throw new RunStoppedError();
    this.debugPort = port;
    const startedAt = Date.now();
    const child = spawn(appPath, [], {
      env: {
        ...process.env,
        WEBVIEW2_USER_DATA_FOLDER: this.userDataDir,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
      },
      stdio: "ignore",
      windowsHide: true
    });
    this.child = child;
    const ended: { how: LaunchExit | null; message: string } = { how: null, message: "" };
    child.on("error", err => {
      ended.message ||= `Could not start ${basename(appPath)}: ${err.message}`;
      ended.how ??= "closed";
    });
    const onExit = (code: number | null) => {
      void launchExit({ pid: child.pid ?? 0, appPath, startedAt, debugPort: port }).then(how => {
        if (how === "starting") return;
        ended.message ||=
          `${basename(appPath)} closed (code ${code ?? "unknown"}) before its window opened. ` +
          "Check that appPath points to the app itself, not its installer.";
        ended.how ??= how;
      });
    };
    child.once("exit", onExit);
    try {
      const wsUrl = await this.waitForCdpEndpoint(port, 90_000, { signal, ended: () => ended.how !== null });
      if (wsUrl || ended.how === "handedOff") return wsUrl;
      throw new Error(ended.message);
    } finally {
      child.off("exit", onExit);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.launched) return;
    this.launched = false;
    const child = this.child;
    this.child = null;
    await stopLaunchedApp({
      pid: child?.pid,
      appPath: this.ctx?.appPath,
      userDataDir: this.userDataDir,
      debugPort: this.debugPort
    });
    try {
      child?.kill();
    } catch {
      // already gone
    }
    stopNativeFrameHost();
    await this.releaseBrowser();
  }

  async clearState(): Promise<void> {
    if (this.userDataDir) {
      await this.disconnect();
      await rm(this.userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      this.userDataDir = await mkdtemp(join(tmpdir(), "solidFlow-wv2-"));
      if (this.ctx) {
        this.ctx.userDataDir = this.userDataDir;
      }
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
}
