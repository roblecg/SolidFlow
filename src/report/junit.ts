import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "../types.js";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function writeJUnitReport(report: RunReport): Promise<string> {
  const path = join(report.reportDir, "junit.xml");
  const cases = report.steps
    .map(step => {
      if (step.status === "failed") {
        return `    <testcase classname="solidFlow" name="${escapeXml(step.command)}" time="${(step.durationMs / 1000).toFixed(3)}">
      <failure message="${escapeXml(step.error ?? "failed")}"/>
    </testcase>`;
      }
      return `    <testcase classname="solidFlow" name="${escapeXml(step.command)}" time="${(step.durationMs / 1000).toFixed(3)}"/>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${escapeXml(report.flowName)}" tests="${report.steps.length}" failures="${report.steps.filter(s => s.status === "failed").length}" time="0">
${cases}
</testsuite>
`;
  await writeFile(path, xml, "utf8");
  return path;
}
