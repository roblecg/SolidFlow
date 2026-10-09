import { existsSync } from "node:fs";
import { join } from "node:path";

/** `2026-09-25_19-23-05_login-validation` */
export function runFolderName(flowName: string, when = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}_${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
  return `${stamp}_${slugFlowName(flowName)}`;
}

export function slugFlowName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "run";
}

/** A folder name that does not already exist under `root`. */
export function uniqueRunFolder(root: string, flowName: string, when = new Date()): string {
  const base = runFolderName(flowName, when);
  let name = base;
  let suffix = 2;
  while (existsSync(join(root, name))) {
    name = `${base}_${suffix}`;
    suffix += 1;
    if (suffix > 50) return `${base}_${Date.now().toString(36)}`;
  }
  return name;
}
