import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import { parseFlowFile } from "./flow/parser.js";
import { validateFlowMeta } from "./flow/validate.js";
import { loadConfigFromAncestors, resolveAppPath } from "./config.js";
import { packageRoot } from "./util/paths.js";

export type DoctorResult = {
  ok: boolean;
  messages: string[];
};

export async function runDoctor(flowPath?: string): Promise<DoctorResult> {
  const messages: string[] = [];
  let ok = true;

  const nodeVer = process.version;
  const major = Number(nodeVer.slice(1).split(".")[0]);
  if (major < 24) {
    ok = false;
    messages.push(`FAIL Node ${nodeVer} (need >= 24.20)`);
  } else {
    messages.push(`OK Node ${nodeVer}`);
  }

  const schemaPath = join(packageRoot(), "schema/flow.schema.json");
  if (existsSync(schemaPath)) {
    messages.push("OK flow.schema.json");
  } else {
    ok = false;
    messages.push("FAIL missing schema/flow.schema.json");
  }

  try {
    const exe = chromium.executablePath();
    if (existsSync(exe)) {
      messages.push("OK Playwright Chromium binary");
    } else {
      ok = false;
      messages.push("FAIL Playwright Chromium not installed (run: pnpm exec playwright-core install chromium)");
    }
  } catch (e) {
    ok = false;
    messages.push(`FAIL Playwright: ${e instanceof Error ? e.message : String(e)}`);
  }

  const config = loadConfigFromAncestors();
  const fallbackPath = resolveAppPath(config);
  const noteFallback = () => {
    if (!fallbackPath) return;
    if (existsSync(fallbackPath)) {
      messages.push(`OK SOLIDFLOW_APP_PATH: ${fallbackPath}`);
    } else {
      ok = false;
      messages.push(`FAIL SOLIDFLOW_APP_PATH not found: ${fallbackPath}`);
    }
  };

  if (process.platform === "win32") {
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq CIM Document Exporter.exe" /NH', {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      if (out.toLowerCase().includes("cim document exporter")) {
        messages.push("WARN CIM Document Exporter already running (single-instance apps may fail launchApp)");
      } else {
        messages.push("OK no conflicting CIM Document Exporter process");
      }
    } catch {
      messages.push("OK process check skipped");
    }
  }

  if (flowPath && existsSync(flowPath)) {
    try {
      const flow = parseFlowFile(flowPath);
      const v = validateFlowMeta(flow);
      if (v.valid) {
        messages.push(`OK flow meta valid: ${flowPath}`);
      } else {
        ok = false;
        messages.push(`FAIL flow validation: ${v.errors.join("; ")}`);
      }
      if (flow.appPath) {
        if (existsSync(flow.appPath)) {
          messages.push(`OK flow appPath: ${flow.appPath}`);
        } else {
          ok = false;
          messages.push(`FAIL flow appPath not found: ${flow.appPath}`);
        }
      } else if (fallbackPath) {
        noteFallback();
      } else {
        messages.push("WARN flow has no appPath. Set appPath to the exe on the flow.");
      }
    } catch (e) {
      ok = false;
      messages.push(`FAIL flow parse: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (fallbackPath) {
    noteFallback();
  }

  return { ok, messages };
}
