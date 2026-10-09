import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { workspaceRoot } from "./workspace.js";

export type WorkspaceNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  children?: WorkspaceNode[];
};

const TEXT_EXT = new Set([".yaml", ".yml", ".json", ".md", ".txt", ".js"]);

const SKIP_DIRS = new Set([
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
const MAX_FLOW_FILES = 2000;
const MAX_DEPTH = 8;

export { workspaceRoot } from "./workspace.js";

export function resolveInsideWorkspace(relPath: string): string {
  const root = workspaceRoot();
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.includes("..") || normalized.includes(":") || normalized.startsWith("/")) {
    throw new Error("Invalid path");
  }
  const abs = resolve(root, normalized);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) {
    throw new Error("Path escapes the workspace");
  }
  return abs;
}

export function resolveFlowPath(relPath: string): string {
  const abs = resolveInsideWorkspace(relPath);
  const ext = extname(abs).toLowerCase();
  if (ext !== ".yaml" && ext !== ".yml") {
    throw new Error("Flow files must end with .yaml");
  }
  return abs;
}

export function resolveWorkspaceFile(relPath: string): string {
  const abs = resolveInsideWorkspace(relPath);
  if (!TEXT_EXT.has(extname(abs).toLowerCase())) {
    throw new Error("Unsupported file type");
  }
  return abs;
}

export async function listWorkspaceTree(): Promise<WorkspaceNode[]> {
  return readTree(workspaceRoot(), workspaceRoot(), 0);
}

async function readTree(dir: string, root: string, depth: number): Promise<WorkspaceNode[]> {
  if (!existsSync(dir) || depth > MAX_DEPTH) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const nodes: WorkspaceNode[] = [];
  for (const entry of entries) {
    if (nodes.length >= MAX_FLOW_FILES) break;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".solidflow") continue;
    const abs = join(dir, entry.name);
    const path = relative(root, abs).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path, kind: "dir", children: await readTree(abs, root, depth + 1) });
    } else if (entry.isFile() && TEXT_EXT.has(extname(entry.name).toLowerCase())) {
      nodes.push({ name: entry.name, path, kind: "file" });
    }
  }
  return nodes;
}

export async function readFlow(relPath: string): Promise<string> {
  return readFile(resolveWorkspaceFile(relPath), "utf8");
}

export async function writeFlow(relPath: string, content: string): Promise<void> {
  const abs = resolveWorkspaceFile(relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

export async function createWorkspaceFile(relPath: string): Promise<string> {
  const normalized = normalizeNewFile(relPath);
  const abs = resolveWorkspaceFile(normalized);
  if (existsSync(abs)) throw new Error("Already exists");
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, defaultFileContent(normalized), "utf8");
  return normalized;
}

export async function createWorkspaceDir(relPath: string): Promise<string> {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some(part => !isSafeSegment(part))) {
    throw new Error("Invalid folder name");
  }
  const abs = resolveInsideWorkspace(normalized);
  if (existsSync(abs)) throw new Error("Already exists");
  if (!existsSync(dirname(abs))) throw new Error("Parent folder does not exist");
  await mkdir(abs);
  return normalized;
}

export function revealWorkspacePath(relPath: string): void {
  const abs = relPath ? resolveInsideWorkspace(relPath) : workspaceRoot();
  if (!existsSync(abs)) throw new Error("Path does not exist");
  if (process.platform !== "win32") throw new Error("Show in Explorer is available on Windows");
  const args = statSync(abs).isDirectory() ? [abs] : [`/select,${abs}`];
  spawn("explorer.exe", args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function normalizeNewFile(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (!normalized || parts.slice(0, -1).some(part => !isSafeSegment(part))) {
    throw new Error("Invalid file name");
  }
  let name = parts[parts.length - 1] ?? "";
  if (!isSafeSegment(name)) throw new Error("Invalid file name");
  if (!extname(name)) name = `${name}.yaml`;
  if (!TEXT_EXT.has(extname(name).toLowerCase())) throw new Error("Unsupported file type");
  parts[parts.length - 1] = name;
  return parts.join("/");
}

function isSafeSegment(name: string): boolean {
  return !!name && name !== "." && name !== ".." && !/[\\/:*?"<>|]/.test(name);
}

function defaultFileContent(relPath: string): string {
  const ext = extname(relPath).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return newFlowTemplate(relPath.split("/").pop() ?? "flow");
  if (ext === ".json") return "{\n}\n";
  if (ext === ".md") {
    const title = (relPath.split("/").pop() ?? "Notes").replace(/\.md$/i, "");
    return `# ${title}\n`;
  }
  return "";
}

export function newFlowTemplate(name: string): string {
  const title = name.replace(/\.ya?ml$/i, "").replace(/[-_]/g, " ");
  return `appPath: "C:/path/to/other-app.exe"
name: ${title}
locale: en
tags: [draft]
---
- launchApp
- assertVisible: "Organization"
- stopApp
`;
}

export function yamlStep(command: string, selector: string): string {
  const needsQuotes = /[:#\n"']|\s/.test(selector) || selector === "";
  const value = needsQuotes ? JSON.stringify(selector) : selector;
  return `- ${command}: ${value}`;
}
