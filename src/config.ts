import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type SolidFlowConfig = {
  appPath?: string;
  reportDir?: string;
  defaultLocale?: string;
  cwd?: string;
};

const CONFIG_NAMES = ["solidFlow.config.yaml", "solidFlow.config.yml", "testx.config.yaml", "testx.config.yml"];

export function loadConfig(cwd: string = process.cwd()): SolidFlowConfig {
  for (const name of CONFIG_NAMES) {
    const path = resolve(cwd, name);
    if (existsSync(path)) {
      const raw = parseYaml(readFileSync(path, "utf8")) as SolidFlowConfig | null;
      return raw ?? {};
    }
  }
  return {};
}

/** Nearest config walking up from `startDir` (e.g. flow folder → solidFlow root). */
export function loadConfigFromAncestors(startDir: string = process.cwd()): SolidFlowConfig {
  let dir = resolve(startDir);
  for (;;) {
    const found = loadConfig(dir);
    if (CONFIG_NAMES.some(name => existsSync(resolve(dir, name)))) {
      return found;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return {};
    }
    dir = parent;
  }
}

export function resolveAppPath(config: SolidFlowConfig): string | undefined {
  return process.env.SOLIDFLOW_APP_PATH ?? config.appPath;
}

export function shellAllowed(): boolean {
  return process.env.SOLIDFLOW_ALLOW_SHELL === "1";
}
