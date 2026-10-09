import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "../types.js";

export async function writeJsonReport(report: RunReport): Promise<string> {
  const path = join(report.reportDir, "report.json");
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
  return path;
}
