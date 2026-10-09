import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig, type SolidFlowConfig } from "../config.js";
import { packageRoot } from "../util/paths.js";

const OUTSIDE_APP = "Select a workspace folder outside the SolidFlow application.";

const MAX_RECENT = 8;

type WorkspaceSettings = {
  workspacePath?: string;
  recentWorkspaces?: string[];
};

let current: string | null = null;
let chosen = false;

export type WorkspaceStatus = {
  path: string;
  chosen: boolean;
  recent: string[];
  places: string[];
};

export const RESULTS_DIR = "test-results";

/** Saved reports for the current workspace: `<workspace>/test-results`. */
export function reportRoot(): string {
  const override = process.env.SOLIDFLOW_REPORT_DIR;
  if (override) return resolve(override);
  return join(workspaceRoot(), RESULTS_DIR);
}

export function workspaceChosen(): boolean {
  return chosen;
}

export function workspaceRoot(): string {
  if (current) return current;
  const fromEnv = acceptedWorkspace(process.env.SOLIDFLOW_WORKSPACE);
  if (fromEnv) {
    current = fromEnv;
    return current;
  }
  throw new Error(OUTSIDE_APP);
}

/** Drop the in-memory selection. Saved settings are left as they are. */
export function forgetWorkspace(): void {
  current = null;
  chosen = false;
}

export function setWorkspaceRoot(dir: string): string {
  const abs = normalizeDirectory(dir);
  if (isAppDirectory(abs)) throw new Error(OUTSIDE_APP);
  current = abs;
  process.env.SOLIDFLOW_WORKSPACE = abs;
  return abs;
}

export function workspaceConfig(): SolidFlowConfig {
  const local = loadConfig(workspaceRoot());
  const tool = loadConfig(packageRoot());
  return {
    appPath: local.appPath || tool.appPath,
    defaultLocale: local.defaultLocale || tool.defaultLocale,
    reportDir: reportRoot(),
    cwd: workspaceRoot()
  };
}

/** Apply SOLIDFLOW_WORKSPACE or the saved folder before Studio serves files. */
export function useSavedWorkspace(): string[] {
  const fromEnv = acceptedWorkspace(process.env.SOLIDFLOW_WORKSPACE);
  if (fromEnv) {
    current = fromEnv;
    chosen = true;
    return scaffoldSolidFlowWorkspace(current);
  }
  const saved = acceptedWorkspace(readSettings().workspacePath);
  if (saved) {
    current = saved;
    process.env.SOLIDFLOW_WORKSPACE = saved;
    chosen = true;
    return scaffoldSolidFlowWorkspace(current);
  }
  chosen = false;
  return [];
}

export function workspaceStatus(): WorkspaceStatus {
  const settings = readSettings();
  const recent = (settings.recentWorkspaces ?? []).filter(path => isDirectory(path) && !isAppDirectory(path));
  const home = homedir();
  const places = [join(home, "Documents"), join(home, "Desktop")].filter(
    path =>
      isDirectory(path) &&
      !isAppDirectory(path) &&
      !recent.some(saved => saved.toLowerCase() === path.toLowerCase())
  );
  return { path: chosen && current ? current : "", chosen, recent, places };
}

export function rememberWorkspace(dir: string): { path: string; created: string[] } {
  const abs = setWorkspaceRoot(dir);
  chosen = true;
  const created = scaffoldSolidFlowWorkspace(abs);
  const settings = readSettings();
  const recent = [abs, ...(settings.recentWorkspaces ?? []).filter(path => path !== abs)].slice(0, MAX_RECENT);
  writeSettings({ workspacePath: abs, recentWorkspaces: recent });
  return { path: abs, created };
}

const SCAFFOLD_SKIP = new Set([
  "node_modules",
  "dist",
  "bin",
  "obj",
  "test-results",
  "solidFlow-reports",
  "solidFlow-reports-test",
  "testx-reports",
  "testx-reports-test"
]);

const WORKSPACE_CONFIG = `# SolidFlow workspace configuration.
flows:
  - "flows/**"
`;

const WORKSPACE_README = `# Workspace

SolidFlow workspace.

- \`.solidflow/config.yaml\` lists where flows live
- \`flows/\` holds YAML flows, grouped in folders
- Other files such as JSON and Markdown stay next to those flows

Right-click the tree to add a file or folder, or to show it in File Explorer.
`;

const EXAMPLE_FLOW = `appPath: "C:/path/to/other-app.exe"
name: Example
locale: en
tags: [draft]
---
- launchApp
- assertVisible: "Organization"
- stopApp
`;

/**
 * Create the SolidFlow workspace layout when it is missing.
 * Existing files are left in place. A previous `.maestro` folder is renamed.
 */
export function scaffoldSolidFlowWorkspace(dir: string): string[] {
  if (isAppDirectory(dir)) throw new Error(OUTSIDE_APP);
  const created: string[] = [];
  const legacy = join(dir, ".maestro");
  const solidflow = join(dir, ".solidflow");
  if (existsSync(legacy) && !existsSync(solidflow)) {
    renameSync(legacy, solidflow);
  }
  const config = join(solidflow, "config.yaml");
  if (!existsSync(config)) {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, WORKSPACE_CONFIG, "utf8");
    created.push(".solidflow/config.yaml");
  }
  const flows = join(dir, "flows");
  if (!existsSync(flows)) {
    mkdirSync(flows);
    created.push("flows");
  }
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(readme, WORKSPACE_README, "utf8");
    created.push("README.md");
  }
  const example = join(flows, "example.yaml");
  if (!existsSync(example) && !directoryHasFlow(dir, 0)) {
    writeFileSync(example, EXAMPLE_FLOW, "utf8");
    created.push("flows/example.yaml");
  }
  return created;
}

function directoryHasFlow(dir: string, depth: number): boolean {
  if (depth > 8 || !existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SCAFFOLD_SKIP.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (directoryHasFlow(abs, depth + 1)) return true;
    } else if (/\.ya?ml$/i.test(entry.name)) {
      return true;
    }
  }
  return false;
}

function normalizeDirectory(dir: string): string {
  const trimmed = dir.trim().replace(/^"(.*)"$/, "$1");
  if (!trimmed) throw new Error("Choose a workspace folder.");
  let abs: string;
  try {
    abs = resolve(trimmed);
  } catch {
    throw new Error("That workspace path is not valid.");
  }
  if (!isDirectory(abs)) throw new Error("That workspace folder does not exist.");
  return abs;
}

function acceptedWorkspace(dir: string | undefined): string | null {
  if (!dir || !isDirectory(dir)) return null;
  const abs = resolve(dir);
  if (isAppDirectory(abs)) return null;
  return abs;
}

function isAppDirectory(dir: string): boolean {
  const root = normalizePath(packageRoot());
  const abs = normalizePath(dir);
  return abs === root || abs.startsWith(`${root}\\`) || abs.startsWith(`${root}/`);
}

function normalizePath(dir: string): string {
  return resolve(dir).replace(/[\\/]+$/, "").toLowerCase();
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function settingsFilePath(): string {
  if (process.env.SOLIDFLOW_SETTINGS_PATH) return process.env.SOLIDFLOW_SETTINGS_PATH;
  const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const current = join(base, "SolidFlow", "settings.json");
  const legacy = join(base, "TestX", "settings.json");
  if (!existsSync(current) && existsSync(legacy)) {
    mkdirSync(dirname(current), { recursive: true });
    copyFileSync(legacy, current);
  }
  return current;
}

function readSettings(): WorkspaceSettings {
  const file = settingsFilePath();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as WorkspaceSettings;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function writeSettings(settings: WorkspaceSettings): void {
  const file = settingsFilePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify(settings, null, 2);
  writeFileSync(tmp, body, "utf8");
  rmSync(file, { force: true });
  try {
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, body, "utf8");
    rmSync(tmp, { force: true });
  }
}
