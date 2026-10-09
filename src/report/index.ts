import type { RunReport } from "../types.js";
import { writeHtmlReport } from "./html.js";
import { writeJsonReport } from "./json.js";
import { writeJUnitReport } from "./junit.js";

export async function writeReports(report: RunReport): Promise<void> {
  await Promise.all([
    writeHtmlReport(report),
    writeJsonReport(report),
    writeJUnitReport(report)
  ]);
}

export { writeHtmlReport, writeJsonReport, writeJUnitReport };
