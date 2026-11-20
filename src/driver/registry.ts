import type { DriverKind } from "../types.js";
import type { AutomationDriver } from "./types.js";
import { ChromiumDriver } from "./chromium.js";
import { isElectronApp } from "./electron-app.js";
import { ElectronDriver } from "./electron.js";
import { WebView2Driver } from "./webview2.js";
import { UnavailableDriver } from "./unavailable.js";

export function createDriver(kind: DriverKind): AutomationDriver {
  switch (kind) {
    case "chromium":
      return new ChromiumDriver();
    case "electron":
      return new ElectronDriver();
    case "webview2":
      return new WebView2Driver();
    case "android":
    case "ios":
    case "browser":
      return new UnavailableDriver(kind);
    default:
      return new WebView2Driver();
  }
}

/** An explicit driver always wins. Electron is chosen only when the flow omits driver and the exe is packaged Electron. */
export function inferDriver(explicit?: DriverKind, appPath?: string): DriverKind {
  if (explicit) return explicit;
  if (appPath && isElectronApp(appPath)) return "electron";
  return "webview2";
}

export function listDevices(): Array<{ id: string; platform: string; driver: DriverKind; status: string }> {
  return [
    {
      id: "local-desktop-1",
      platform: "win32",
      driver: "webview2",
      status: "available"
    },
    {
      id: "local-chromium",
      platform: "win32",
      driver: "chromium",
      status: "available"
    },
    {
      id: "local-electron",
      platform: "win32",
      driver: "electron",
      status: "available"
    }
  ];
}
