import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type SolidFlowConfig = {
  appPath?: string;
  reportDir?: string;
  defaultLocale?: string;
  cwd?: string;
};

const CONFIG_NAMES = [
  ".solidflow/config.yaml",
  ".solidflow/config.yml",
  "solidFlow.config.yaml",
  "solidFlow.config.yml",
  "testx.config.yaml",
  "testx.config.yml"
];

function configFiles(dir: string): string[] {
  return CONFIG_NAMES.map(name => resolve(dir, name)).filter(path => existsSync(path));
}

/**
 * Scaffolding writes `.solidflow/config.yaml` into every workspace, so it is merged over an older
 * `solidFlow.config.yaml` key by key instead of replacing it.
 */
export function loadConfig(cwd: string = process.cwd()): SolidFlowConfig {
  const merged: Record<string, unknown> = {};
  for (const path of configFiles(resolve(cwd)).reverse()) {
    const raw = parseYaml(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined && value !== null && value !== "") merged[key] = value;
    }
  }
  return merged as SolidFlowConfig;
}

/** Nearest config walking up from `startDir` (e.g. flow folder → solidFlow root). */
export function loadConfigFromAncestors(startDir: string = process.cwd()): SolidFlowConfig {
  let dir = resolve(startDir);
  for (;;) {
    if (configFiles(dir).length) return loadConfig(dir);
    const parent = dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

export function resolveAppPath(config: SolidFlowConfig): string | undefined {
  return process.env.SOLIDFLOW_APP_PATH ?? config.appPath;
}

export function shellAllowed(): boolean {
  return process.env.SOLIDFLOW_ALLOW_SHELL === "1";
}
