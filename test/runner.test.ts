import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runFlowFile } from "../src/flow/runner.js";
import { parseFlowContent, parseFlowFile } from "../src/flow/parser.js";
import { packageRoot } from "../src/util/paths.js";

describe("local page flow", () => {
  const pagesDir = join(packageRoot(), "test/pages");
  const smokePath = join(pagesDir, "smoke.yaml");
  const loginUrl = pathToFileURL(join(pagesDir, "login.html")).href;

  it("parses smoke flow", () => {
    const flow = parseFlowFile(smokePath);
    expect(flow.appId).toBe("page.demo");
    expect(flow.steps.length).toBeGreaterThan(3);
    expect(flow.sections).toEqual([
      expect.objectContaining({
        number: 0,
        name: "Unassigned",
        stepIndices: expect.any(Array)
      })
    ]);
    expect(flow.sections![0]!.stepIndices).toHaveLength(flow.steps.length);
  });

  it("parses named sections in order", () => {
    const flow = parseFlowContent(`appId: page.demo
---
- section:
    number: 2
    name: Second
    description: Later
    steps:
      - stopApp
- section:
    number: 1
    name: First
    description: Earlier
    steps:
      - launchApp
`);
    expect(flow.steps).toEqual(["stopApp", "launchApp"]);
    expect(flow.sections!.map(s => s.number)).toEqual([1, 2]);
    expect(flow.sections![0]).toMatchObject({ name: "First", stepIndices: [1] });
    expect(flow.sections![1]).toMatchObject({ name: "Second", stepIndices: [0] });
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
        cwd: pagesDir,
        pageUrl: loginUrl
      });
      expect(report.status).toBe("passed");
      expect(existsSync(join(report.reportDir, "report.html"))).toBe(true);
      expect(existsSync(join(report.reportDir, "report.json"))).toBe(true);
      expect(existsSync(join(report.reportDir, "junit.xml"))).toBe(true);
      const json = JSON.parse(readFileSync(join(report.reportDir, "report.json"), "utf8")) as {
        steps: unknown[];
      };
      expect(json.steps.length).toBe(report.steps.length);
      expect(report.reportDir.replace(/\\/g, "/")).toMatch(/\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_page-smoke$/);
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it("runs the maestro command coverage flow", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "solidflow-results-"));
    try {
      const report = await runFlowFile(join(pagesDir, "commands.yaml"), {
        reportDir,
        headless: true,
        cwd: pagesDir,
        pageUrl: loginUrl
      });
      expect(report.status).toBe("passed");
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it("follows a popup window and returns to the original page", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "solidflow-results-"));
    try {
      const report = await runFlowFile(join(pagesDir, "popup.yaml"), {
        reportDir,
        headless: true,
        cwd: pagesDir,
        pageUrl: pathToFileURL(join(pagesDir, "popup-host.html")).href
      });
      expect(report.status).toBe("passed");
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });
});
