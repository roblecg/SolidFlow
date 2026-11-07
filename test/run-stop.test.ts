import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runFlowDocument, type DriverSlot } from "../src/flow/runner.js";
import { parseFlowContent } from "../src/flow/parser.js";
import { WebView2Driver } from "../src/driver/webview2.js";
import { packageRoot } from "../src/util/paths.js";

const loginUrl = pathToFileURL(join(packageRoot(), "test/pages/login.html")).href;

const longWait = parseFlowContent(`appId: page.stop
driver: chromium
---
- launchApp
- extendedWaitUntil:
    visible: "Never shown on this page"
    timeout: 60000
- tapOn: "Continue"
`);

describe("stopping a run", () => {
  it("ends a long wait right away and closes the app it was driving", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "solidflow-stop-"));
    const abort = new AbortController();
    const slot: DriverSlot = { current: null };
    let stoppedAt = 0;
    try {
      const report = await runFlowDocument(longWait, {
        reportDir,
        headless: true,
        pageUrl: loginUrl,
        keepDriver: true,
        driverSlot: slot,
        signal: abort.signal,
        onStep: event => {
          if (event.status === "running" && event.command.startsWith("extendedWaitUntil")) {
            setTimeout(() => {
              stoppedAt = Date.now();
              abort.abort();
            }, 300);
          }
        }
      });
      expect(report.status).toBe("stopped");
      expect(Date.now() - stoppedAt).toBeLessThan(6_000);
      expect(report.steps.map(step => step.status)).toEqual(["passed", "skipped"]);
      expect(slot.current).toBeNull();
    } finally {
      await slot.current?.disconnect();
      rmSync(reportDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps the app open when Stop comes between steps", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "solidflow-stop-"));
    const abort = new AbortController();
    const slot: DriverSlot = { current: null };
    try {
      const report = await runFlowDocument(longWait, {
        reportDir,
        headless: true,
        pageUrl: loginUrl,
        keepDriver: true,
        driverSlot: slot,
        signal: abort.signal,
        onStep: event => {
          if (event.status === "passed" && event.command === "launchApp") abort.abort();
        }
      });
      expect(report.status).toBe("stopped");
      expect(report.steps.map(step => step.status)).toEqual(["passed"]);
      expect(slot.current).not.toBeNull();
    } finally {
      await slot.current?.disconnect();
      rmSync(reportDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.runIf(process.platform === "win32")("WebView2 launch", () => {
  it("fails in seconds when the exe closes before its window opens", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "solidflow-wv2-test-"));
    const driver = new WebView2Driver();
    const started = Date.now();
    try {
      await expect(
        driver.connect({
          appId: "hostname.exe",
          locale: "en",
          appPath: "C:/Windows/System32/hostname.exe",
          userDataDir
        })
      ).rejects.toThrow(/hostname\.exe closed .* before its window opened/);
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 40_000);
});
