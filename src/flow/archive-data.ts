import { existsSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { FlowError } from "../types.js";
import { slugFlowName } from "../report/run-folder.js";
import { interpolateEnv } from "../util/ids.js";

export type ArchiveAction = "move" | "copy";

export type ArchiveDataOptions = {
  action: unknown;
  location: unknown;
  flowDir: string;
  sectionName: string;
  env: Record<string, string>;
  /** This run's report folder: `<workspace>/test-results/<runId>`. */
  reportDir: string;
  now?: Date;
  /** Override archive root (tests). Defaults to `<reportDir>/archive`. */
  archiveRoot?: string;
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `yyyyMMdd_HHmmss` plus a short random suffix; never collides under `archiveRoot`. */
export function uniqueArchiveFolderName(
  archiveRoot: string,
  sectionName: string,
  when = new Date()
): string {
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}_${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  const slug = slugFlowName(sectionName);
  const random = randomBytes(3).toString("hex");
  const base = `archive_${slug}_${stamp}_${random}`;
  let name = base;
  let suffix = 2;
  while (existsSync(join(archiveRoot, name))) {
    name = `${base}_${suffix}`;
    suffix += 1;
    if (suffix > 50) return `${base}_${Date.now().toString(36)}`;
  }
  return name;
}

function resolveLocation(location: string, flowDir: string): string {
  return isAbsolute(location) ? resolve(location) : resolve(flowDir, location);
}

/**
 * Copy or move all contents of `location` into
 * `<reportDir>/archive/archive_<section>_<uniqueId>/` for this test run.
 */
function normalizeAction(value: unknown): ArchiveAction {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  // "cut" is accepted as an alias for move (remove source after a successful transfer).
  if (raw === "move" || raw === "cut") return "move";
  if (raw === "copy") return "copy";
  throw new FlowError('archiveData requires action: "move" (or "cut") or "copy"');
}

export async function executeArchiveData(options: ArchiveDataOptions): Promise<string> {
  const action = normalizeAction(options.action);

  if (typeof options.location !== "string" || !options.location.trim()) {
    throw new FlowError("archiveData requires location (a folder path)");
  }
  const locationText = interpolateEnv(options.location.trim(), options.env);
  const source = resolveLocation(locationText, options.flowDir);

  if (!existsSync(source)) {
    throw new FlowError(`archiveData location does not exist: ${source}`);
  }
  let sourceStat;
  try {
    sourceStat = statSync(source);
  } catch {
    throw new FlowError(`archiveData location is not accessible: ${source}`);
  }
  if (!sourceStat.isDirectory()) {
    throw new FlowError(`archiveData location must be a folder: ${source}`);
  }

  if (!options.reportDir?.trim() && !options.archiveRoot) {
    throw new FlowError("archiveData requires the current run report folder");
  }
  const archiveRoot = options.archiveRoot ?? join(options.reportDir, "archive");
  await mkdir(archiveRoot, { recursive: true });
  const folderName = uniqueArchiveFolderName(archiveRoot, options.sectionName, options.now);
  const dest = join(archiveRoot, folderName);
  await mkdir(dest, { recursive: true });

  const entries = readdirSync(source);
  if (entries.length === 0) {
    console.warn(`archiveData: location is empty (${source}); created ${dest}`);
    console.log(`archiveData ${action} finished (empty source): ${dest}`);
    return dest;
  }

  console.log(
    `archiveData ${action} started: ${entries.length} item(s) from ${source} → ${dest}`
  );

  try {
    for (const entry of entries) {
      const from = join(source, entry);
      const to = join(dest, entry);
      await cp(from, to, { recursive: true, force: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Source is left untouched on copy failure (move never deletes until copy succeeds).
    throw new FlowError(`archiveData ${action} failed while copying to ${dest}: ${message}`);
  }

  if (action === "move") {
    try {
      for (const entry of entries) {
        await rm(join(source, entry), { recursive: true, force: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new FlowError(
        `archiveData move copied to ${dest} but failed to remove source contents: ${message}`
      );
    }
  }

  const remaining = readdirSync(source);
  if (action === "move" && remaining.length > 0) {
    throw new FlowError(
      `archiveData move incomplete: ${remaining.length} item(s) still in ${source}`
    );
  }

  console.log(`archiveData ${action} finished: ${dest}`);
  return dest;
}
