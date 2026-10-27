import type { Page } from "playwright-core";
import { DriverNotAvailableError, type DriverKind, type DeviceInfo } from "../types.js";
import type { AutomationDriver, DriverContext } from "./types.js";
import type { SwitchWindowChoice, WindowQuery } from "./window-target.js";

export class UnavailableDriver implements AutomationDriver {
  constructor(readonly kind: DriverKind) {}

  async connect(_ctx: DriverContext): Promise<void> {
    throw new DriverNotAvailableError(this.kind);
  }

  async disconnect(): Promise<void> {}

  async clearState(): Promise<void> {
    throw new DriverNotAvailableError(this.kind);
  }

  getPage(): Page {
    throw new DriverNotAvailableError(this.kind);
  }

  getDeviceInfo(): DeviceInfo {
    return {
      platform: "n/a",
      hostname: "n/a",
      driver: this.kind
    };
  }

  async takeScreenshot(_name: string): Promise<string> {
    throw new DriverNotAvailableError(this.kind);
  }

  async waitForPopup(_timeoutMs: number): Promise<void> {
    throw new DriverNotAvailableError(this.kind);
  }

  async switchToMain(): Promise<void> {
    throw new DriverNotAvailableError(this.kind);
  }

  async switchToWindow(_query: WindowQuery, _timeoutMs: number): Promise<void> {
    throw new DriverNotAvailableError(this.kind);
  }

  async listSwitchWindows(): Promise<SwitchWindowChoice[]> {
    return [];
  }

  webWindowFocused(): boolean {
    return false;
  }

  async releaseClosedNativeWindow(): Promise<void> {}

  nativeApp(): { pid: number; appPath: string; hwnd?: string } | null {
    return null;
  }

  async useWebWindow(_selector?: string): Promise<boolean> {
    return false;
  }
}
