#!/usr/bin/env node
import { parseArgs } from "node:util";
import { watch } from "node:fs";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
import { runDoctor } from "./doctor.js";
import { listDevices, createDriver, inferDriver } from "./driver/registry.js";
import { runFlowFile } from "./flow/runner.js";
import { parseFlowFile } from "./flow/parser.js";
import { matchesName, matchesTags } from "./flow/validate.js";
import { reportRoot, useSavedWorkspace } from "./studio/workspace.js";
import { fixturePageUrl } from "./util/paths.js";
import { captureHierarchy } from "./inspector/hierarchy.js";
import { writeInspectorPage } from "./inspector/viewer.js";
import { RECORDER_INIT_SCRIPT, stepsToYaml, type RecordedStep } from "./recorder/script.js";
import { writeRecorderEditor } from "./recorder/editor.js";
import { startStudio } from "./studio/server.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tags: { type: "string", short: "t" },
    name: { type: "string", short: "n" },
    env: { type: "string", multiple: true },
    "step-retry": { type: "string" },
    "run-retry": { type: "string" },
    headed: { type: "boolean", default: false },
    out: { type: "string" },
    "no-browser": { type: "boolean", default: false }
  }
});

function parseEnvPairs(pairs?: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of pairs ?? []) {
    const i = p.indexOf("=");
    if (i > 0) env[p.slice(0, i)] = p.slice(i + 1);
  }
  return env;
}

function usage(): void {
  console.log(`SolidFlow — desktop E2E runner

Usage:
  solidFlow doctor [flow.yaml]
  solidFlow devices
  solidFlow test run <flow.yaml> [--tags a,b] [--name filter] [--env K=V]
  solidFlow test watch <flow.yaml>
  solidFlow inspect <url-or-flow.yaml>
  solidFlow record <url> [--out recorded.yaml]
  solidFlow studio
  solidFlow report open [reportDir]
  solidFlow cloud start   (not available in this build)
`);
}

async function main(): Promise<void> {
  const cmd = positionals[0];
  const sub = positionals[1];
  const arg = positionals[2];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage();
    process.exit(0);
  }

  if (cmd === "doctor") {
    const flow = sub && !sub.startsWith("-") ? sub : undefined;
    const result = await runDoctor(flow);
    for (const m of result.messages) console.log(m);
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === "devices") {
    for (const d of listDevices()) {
      console.log(`${d.id}\t${d.platform}\t${d.driver}\t${d.status}`);
    }
    return;
  }

  if (cmd === "cloud") {
    console.error('solidFlow cloud start is not available in this build. See docs/architecture.md.');
    process.exit(1);
  }

  if (cmd === "test" && sub === "run") {
    const flowPath = arg ?? positionals[2];
    if (!flowPath) {
      console.error("Missing flow path");
      process.exit(1);
    }
    useSavedWorkspace();
    const flow = parseFlowFile(resolve(flowPath));
    const tagList = values.tags?.split(",").map(s => s.trim()).filter(Boolean);
    if (!matchesTags(flow, tagList) || !matchesName(flow, values.name)) {
      console.log("Flow skipped (tag/name filter)");
      return;
    }
    try {
      const report = await runFlowFile(resolve(flowPath), {
        tags: tagList,
        nameFilter: values.name,
        env: parseEnvPairs(values.env),
        stepRetry: values["step-retry"] ? Number(values["step-retry"]) : undefined,
        runRetry: values["run-retry"] ? Number(values["run-retry"]) : undefined,
        reportDir: reportRoot(),
        headless: !values.headed
      });
      console.log(`Run ${report.status}: ${report.reportDir}/report.html`);
      if (report.status === "failed") process.exit(1);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
    return;
  }

  if (cmd === "test" && sub === "watch") {
    const flowPath = resolve(arg ?? "");
    if (!existsSync(flowPath)) {
      console.error("Missing flow path");
      process.exit(1);
    }
    const run = () => {
      console.log("\n--- watch run ---");
      void mainWatchRun(flowPath);
    };
    run();
    watch(flowPath, () => run());
    return;
  }

  if (cmd === "inspect") {
    const target = sub;
    if (!target) {
      console.error("Usage: solidFlow inspect <url-or-flow.yaml>");
      process.exit(1);
    }
    await runInspect(target, values.out);
    return;
  }

  if (cmd === "record") {
    const url = sub;
    if (!url) {
      console.error("Usage: solidFlow record <url> [--out file.yaml]");
      process.exit(1);
    }
    await runRecord(url, values.out ?? "recorded.yaml");
    return;
  }

  if (cmd === "studio") {
    const port = sub && /^\d+$/.test(sub) ? Number(sub) : 4317;
    await startStudio(port, { openBrowser: values["no-browser"] !== true });
    return;
  }

  if (cmd === "report" && sub === "open") {
    useSavedWorkspace();
    const dir = arg ? resolve(arg) : findLatestReport(reportRoot());
    if (!dir) {
      console.error("No reports found");
      process.exit(1);
    }
    const html = join(dir, "report.html");
    if (process.platform === "win32") {
      execSync(`start "" "${html}"`, { shell: "cmd.exe" });
    } else {
      console.log(html);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

async function mainWatchRun(flowPath: string): Promise<void> {
  try {
    useSavedWorkspace();
    const report = await runFlowFile(flowPath, { reportDir: reportRoot() });
    console.log(`${report.status} — ${report.steps.length} steps`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
  }
}

function findLatestReport(root: string): string | null {
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .map(name => join(root, name))
    .filter(p => statSync(p).isDirectory() && existsSync(join(p, "report.html")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

async function runInspect(target: string, out?: string): Promise<void> {
  const resolved = resolve(target);
  let url = target;
  let appId = "inspect.session";
  if (existsSync(resolved) && resolved.endsWith(".yaml")) {
    const flow = parseFlowFile(resolved);
    appId = flow.appId;
    const driverKind = inferDriver(flow.appId, flow.driver);
    if (driverKind === "chromium") {
      url = fixturePageUrl();
    } else {
      console.error("Inspect for WebView2 flows: launch app separately; use record URL or fixture.");
      process.exit(1);
    }
  } else if (!target.includes("://")) {
    url = pathToFileURL(resolve(target)).href;
  }

  const driver = createDriver("chromium");
  useSavedWorkspace();
  const outDir = out ? resolve(out) : join(reportRoot(), "inspector");
  await mkdir(outDir, { recursive: true });
  await driver.connect({
    appId,
    locale: "en",
    fixtureUrl: url,
    headless: true,
    screenshotDir: outDir
  });
  const page = driver.getPage();
  const hierarchy = await captureHierarchy(page);
  const shot = await driver.takeScreenshot("inspect");
  const relShot = shot.replace(outDir + "\\", "").replace(outDir + "/", "");
  const htmlPath = await writeInspectorPage(outDir, hierarchy, relShot);
  await driver.disconnect();
  console.log(`Inspector: ${htmlPath}`);
}

async function runRecord(url: string, outFile: string): Promise<void> {
  useSavedWorkspace();
  let target = url;
  if (!url.includes("://")) {
    target = pathToFileURL(resolve(url)).href;
  }
  const driver = createDriver("chromium");
  await driver.connect({
    appId: "record.session",
    locale: "en",
    fixtureUrl: target,
    headless: false,
    screenshotDir: join(reportRoot(), "record")
  });
  const page = driver.getPage();
  await page.addInitScript(RECORDER_INIT_SCRIPT);
  await page.reload();
  console.log("Recording… Interact with the page. Press Ctrl+C to save.");

  await new Promise<void>(resolvePromise => {
    process.on("SIGINT", () => resolvePromise());
  });

  const steps = (await page.evaluate(`(() => {
    const recorder = globalThis.__solidFlowRecorder;
    return recorder && Array.isArray(recorder.steps) ? recorder.steps : [];
  })()`)) as RecordedStep[];

  const yaml = stepsToYaml(steps, "fixture.demo");
  const outPath = resolve(outFile);
  await writeFile(outPath, yaml, "utf8");
  const editorDir = join(dirname(outPath), ".solidFlow-recorder");
  await mkdir(editorDir, { recursive: true });
  const editorHtml = await writeRecorderEditor(
    editorDir,
    JSON.stringify(steps),
    yaml.split("\n")[0] ?? "appId: fixture.demo"
  );
  await driver.disconnect();
  console.log(`Saved ${steps.length} steps to ${outPath}`);
  console.log(`Edit steps: ${editorHtml}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
