import type { DriverKind } from "../types.js";
import type { AutomationDriver } from "./types.js";
import { ChromiumDriver } from "./chromium.js";
import { WebView2Driver } from "./webview2.js";
import { UnavailableDriver } from "./unavailable.js";

export function createDriver(kind: DriverKind): AutomationDriver {
  switch (kind) {
    case "chromium":
      return new ChromiumDriver();
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

export function inferDriver(explicit?: DriverKind): DriverKind {
  return explicit ?? "webview2";
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
    }
  ];
}
