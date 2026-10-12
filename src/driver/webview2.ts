import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverKind, DeviceInfo } from "../types.js";
import type { DriverContext } from "./types.js";
import { PlaywrightBaseDriver } from "./playwright-base.js";
import { getFreePort } from "../util/port.js";

export class WebView2Driver extends PlaywrightBaseDriver {
  readonly kind: DriverKind = "webview2";
  private child: ChildProcess | null = null;
  private debugPort = 0;
  private userDataDir = "";

  async connect(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    if (!ctx.appPath) {
      throw new Error("WebView2 driver requires appPath on the flow (or SOLIDFLOW_APP_PATH).");
    }
    this.debugPort = await getFreePort();
    this.userDataDir =
      ctx.userDataDir ?? (await mkdtemp(join(tmpdir(), "solidFlow-wv2-")));
    ctx.userDataDir = this.userDataDir;

    const env = {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: this.userDataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${this.debugPort}`
    };

    this.child = spawn(ctx.appPath, [], {
      env,
      stdio: "ignore",
      windowsHide: true
    });

    this.child.on("error", err => {
      console.error("WebView2 app spawn error:", err.message);
    });

    const wsUrl = await this.waitForCdpEndpoint(this.debugPort, 90_000);
    await this.connectOverCdp(wsUrl);

    await this.getPage().waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
  }

  async disconnect(): Promise<void> {
    await super.disconnect();
    if (this.child && !this.child.killed) {
      this.child.kill();
      this.child = null;
    }
  }

  async clearState(): Promise<void> {
    if (this.userDataDir) {
      await this.disconnect();
      await rm(this.userDataDir, { recursive: true, force: true });
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

  nativeApp(): { pid: number; appPath: string } | null {
    const appPath = this.ctx?.appPath;
    if (!appPath) return null;
    return { pid: this.child?.pid ?? 0, appPath };
  }
}
