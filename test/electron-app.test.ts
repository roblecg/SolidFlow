import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  electronAttachError,
  electronLaunchArgs,
  electronWindowTimeoutMessage,
  isAppPageUrl,
  isElectronApp,
  isKcpsMainPageUrl,
  kcpsInstallerHint,
  preferKcpsPageUrl
} from "../src/driver/electron-app.js";
import { createDriver, inferDriver } from "../src/driver/registry.js";
import { validateFlowMeta } from "../src/flow/validate.js";
import type { FlowDocument } from "../src/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeElectronExe(): string {
  const dir = mkdtempSync(join(tmpdir(), "solidflow-electron-"));
  dirs.push(dir);
  for (const name of ["chrome_100_percent.pak", "resources.pak", "icudtl.dat", "snapshot_blob.bin"]) {
    writeFileSync(join(dir, name), "");
  }
  mkdirSync(join(dir, "resources"));
  writeFileSync(join(dir, "resources", "app.asar"), "");
  return join(dir, "JcsUiAgent.exe");
}

function flow(driver?: FlowDocument["driver"]): FlowDocument {
  return { appId: "demo", steps: [], driver };
}

describe("electron app detection", () => {
  it("detects a packaged Electron layout and ignores a plain exe folder", () => {
    const exe = fakeElectronExe();
    expect(isElectronApp(exe)).toBe(true);
    const plain = mkdtempSync(join(tmpdir(), "solidflow-plain-"));
    dirs.push(plain);
    expect(isElectronApp(join(plain, "CIM Document Exporter.exe"))).toBe(false);
  });

  it("keeps an explicit driver and otherwise picks electron only for that layout", () => {
    const exe = fakeElectronExe();
    expect(inferDriver(undefined, exe)).toBe("electron");
    expect(inferDriver("webview2", exe)).toBe("webview2");
    expect(inferDriver("chromium", exe)).toBe("chromium");
    expect(inferDriver(undefined, join(tmpdir(), "missing", "app.exe"))).toBe("webview2");
    expect(createDriver("electron").kind).toBe("electron");
    expect(createDriver("webview2").kind).toBe("webview2");
  });

  it("accepts driver electron and points installer exes at JcsUiAgent", () => {
    expect(validateFlowMeta(flow("electron")).valid).toBe(true);
    expect(validateFlowMeta(flow("webview2")).valid).toBe(true);
    expect(kcpsInstallerHint("C:/downloads/cloudprintscan_kdas-stage_2.1.09512.1.exe")).toMatch(/JcsUiAgent\.exe/);
    expect(kcpsInstallerHint("C:/apps/JcsUiAgent/JcsUiAgent.exe")).toBeUndefined();
    expect(kcpsInstallerHint(fakeElectronExe().replace(/JcsUiAgent\.exe$/, "cloudprintscan.exe"))).toBeUndefined();
  });

  it("builds Electron debug args and ignores blank pages", () => {
    expect(electronLaunchArgs(9222, "C:/temp/profile")).toEqual([
      "--remote-debugging-port=9222",
      "--remote-allow-origins=*",
      "--user-data-dir=C:/temp/profile"
    ]);
    expect(isAppPageUrl("about:blank")).toBe(false);
    expect(isAppPageUrl("devtools://devtools/bundled/inspector.html")).toBe(false);
    expect(isAppPageUrl("file:///app/OrgLogin.html")).toBe(true);
    expect(isKcpsMainPageUrl("file:///C:/Program%20Files/Kyocera/renderer/JobList.html")).toBe(true);
    expect(isKcpsMainPageUrl("file:///app/ProxySettings.html")).toBe(false);
    expect(
      preferKcpsPageUrl([
        "devtools://devtools/bundled/inspector.html",
        "file:///app/AppUpdate.html",
        "file:///app/JobList.html"
      ])
    ).toBe("file:///app/JobList.html");
    expect(preferKcpsPageUrl(["file:///app/AppUpdate.html", "file:///app/ProxySettings.html"])).toBe(
      "file:///app/AppUpdate.html"
    );
    expect(electronWindowTimeoutMessage("C:/Kyocera/JcsUiAgent/JcsUiAgent.exe", 55758)).toMatch(/5570/);
    expect(electronWindowTimeoutMessage("C:/apps/Other.exe", 55758)).not.toMatch(/5570/);
    expect(
      electronAttachError(
        "browserType.connectOverCDP: browserType.connectOverCDP: browser.close: solidFlow disconnect"
      )
    ).toMatch(/finished attaching/);
    expect(electronAttachError("CDP did not become ready on port 9222")).toBeUndefined();
  });
});
