import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RunPause, runFlowDocument, type DriverSlot } from "../src/flow/runner.js";
import { parseFlowContent } from "../src/flow/parser.js";
import { packageRoot } from "../src/util/paths.js";

const loginUrl = pathToFileURL(join(packageRoot(), "test/pages/login.html")).href;

const flow = parseFlowContent(`appId: page.pause
driver: chromium
---
- launchApp
- assertVisible: "Sign in"
- repeat:
    times: 2
    commands:
      - assertVisible: "Continue"
- tapOn: "Continue"
`);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRun(test: (reportDir: string, slot: DriverSlot) => Promise<void>): Promise<void> {
  const reportDir = mkdtempSync(join(tmpdir(), "solidflow-pause-"));
  const slot: DriverSlot = { current: null };
  try {
    await test(reportDir, slot);
  } finally {
    await slot.current?.disconnect();
    rmSync(reportDir, { recursive: true, force: true });
  }
}

describe("pausing a run", () => {
  it("holds before the next step and carries on after resume", async () => {
    await withRun(async (reportDir, slot) => {
      const pause = new RunPause();
      const events: string[] = [];
      let pausedAt = 0;
      const report = await runFlowDocument(flow, {
        reportDir,
        headless: true,
        pageUrl: loginUrl,
        keepDriver: true,
        driverSlot: slot,
        pause,
        onPause: paused => {
          events.push(paused ? "paused" : "resumed");
          if (paused) {
            pausedAt = Date.now();
            setTimeout(() => pause.set(false), 1_200);
          }
        },
        onStep: event => {
          events.push(`${event.status}: ${event.command}`);
          if (event.status === "passed" && event.command === "launchApp") pause.set(true);
        }
      });
      expect(report.status).toBe("passed");
      expect(events.slice(0, 4)).toEqual([
        "running: launchApp",
        "passed: launchApp",
        "paused",
        "resumed"
      ]);
      expect(events[4]).toMatch(/^running: assertVisible/);
      expect(Date.now() - pausedAt).toBeGreaterThanOrEqual(1_200);
      expect(report.steps[1]!.durationMs).toBeLessThan(1_200);
      expect(report.steps.every(step => step.status === "passed")).toBe(true);
    });
  }, 30_000);

  it("pauses between the steps inside repeat", async () => {
    await withRun(async (reportDir, slot) => {
      const pause = new RunPause();
      let pausedDuring = "";
      let current = "";
      const report = await runFlowDocument(flow, {
        reportDir,
        headless: true,
        pageUrl: loginUrl,
        keepDriver: true,
        driverSlot: slot,
        pause,
        onPause: paused => {
          if (!paused) return;
          pausedDuring = current;
          setTimeout(() => pause.set(false), 300);
        },
        onStep: event => {
          if (event.status !== "running") return;
          current = event.command;
          if (event.command.startsWith("repeat")) pause.set(true);
        }
      });
      expect(report.status).toBe("passed");
      expect(pausedDuring).toMatch(/^repeat/);
    });
  }, 30_000);

  it("stops right away when Stop comes while paused", async () => {
    await withRun(async (reportDir, slot) => {
      const pause = new RunPause();
      const abort = new AbortController();
      let stoppedAt = 0;
      const report = await runFlowDocument(flow, {
        reportDir,
        headless: true,
        pageUrl: loginUrl,
        keepDriver: true,
        driverSlot: slot,
        signal: abort.signal,
        pause,
        onPause: paused => {
          if (!paused) return;
          setTimeout(() => {
            stoppedAt = Date.now();
            abort.abort();
          }, 300);
        },
        onStep: event => {
          if (event.status === "passed" && event.command === "launchApp") pause.set(true);
        }
      });
      expect(report.status).toBe("stopped");
      expect(Date.now() - stoppedAt).toBeLessThan(1_000);
      expect(report.steps.map(step => step.status)).toEqual(["passed"]);
      expect(slot.current).not.toBeNull();
    });
  }, 30_000);
});

describe("RunPause", () => {
  it("lets waits through at once when it is not paused", async () => {
    const pause = new RunPause();
    const started = Date.now();
    await pause.wait(5_000);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("releases every wait on resume", async () => {
    const pause = new RunPause();
    pause.set(true);
    const waits = [pause.wait(5_000), pause.wait(5_000)];
    await sleep(50);
    const started = Date.now();
    pause.set(false);
    await Promise.all(waits);
    expect(Date.now() - started).toBeLessThan(50);
  });
});
