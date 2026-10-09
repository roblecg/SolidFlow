import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runFlowFile } from "../src/flow/runner.js";
import { parseFlowContent, parseFlowFile } from "../src/flow/parser.js";
import { packageRoot } from "../src/util/paths.js";

describe("fixture flow", () => {
  const fixtureDir = join(packageRoot(), "test/fixture");
  const smokePath = join(fixtureDir, "smoke.yaml");

  it("parses smoke flow", () => {
    const flow = parseFlowFile(smokePath);
    expect(flow.appId).toBe("fixture.demo");
    expect(flow.steps.length).toBeGreaterThan(3);
  });

  it("uses appPath when appId is omitted", () => {
    const flow = parseFlowContent('appPath: "C:/path/to/other-app.exe"\n---\n- launchApp\n');
    expect(flow.appPath).toBe("C:/path/to/other-app.exe");
    expect(flow.appId).toBe("other-app.exe");
  });

  it("rejects a flow with neither appPath nor appId", () => {
    expect(() => parseFlowContent("---\n- launchApp\n")).toThrow(/appPath or appId is required/);
  });

  it("runs smoke flow end-to-end", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "solidflow-results-"));
    try {
      const report = await runFlowFile(smokePath, {
        reportDir,
        headless: true,
        cwd: fixtureDir
      });
      expect(report.status).toBe("passed");
      expect(existsSync(join(report.reportDir, "report.html"))).toBe(true);
      expect(existsSync(join(report.reportDir, "report.json"))).toBe(true);
      expect(existsSync(join(report.reportDir, "junit.xml"))).toBe(true);
      const json = JSON.parse(readFileSync(join(report.reportDir, "report.json"), "utf8")) as {
        steps: unknown[];
      };
      expect(json.steps.length).toBe(report.steps.length);
      expect(report.reportDir.replace(/\\/g, "/")).toMatch(/\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_fixture-smoke$/);
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it("runs the maestro command coverage flow", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "solidflow-results-"));
    try {
      const report = await runFlowFile(join(fixtureDir, "commands.yaml"), {
        reportDir,
        headless: true,
        cwd: fixtureDir
      });
      expect(report.status).toBe("passed");
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it("follows a popup window and returns to the original page", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "solidflow-results-"));
    try {
      const report = await runFlowFile(join(fixtureDir, "popup.yaml"), {
        reportDir,
        headless: true,
        cwd: fixtureDir,
        env: { FIXTURE_URL: pathToFileURL(join(fixtureDir, "popup-host.html")).href }
      });
      expect(report.status).toBe("passed");
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });
});
