import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeArchiveData, uniqueArchiveFolderName } from "../src/flow/archive-data.js";
import { FlowError } from "../src/types.js";
import { listCommands } from "../src/flow/commands.js";

describe("archiveData", () => {
  it("is listed in the SolidFlow command catalog", () => {
    const command = listCommands().find(item => item.name === "archiveData");
    expect(command?.available).toBe(true);
    expect(command?.yaml).toContain("action: move");
    expect(command?.yaml).toContain("location:");
  });

  it("copies folder contents and leaves the source intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "solidflow-archive-"));
    const source = join(root, "data");
    const archiveRoot = join(root, "archive");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "a.txt"), "alpha");
    await writeFile(join(source, "nested", "b.txt"), "beta");

    const dest = await executeArchiveData({
      action: "copy",
      location: source,
      flowDir: root,
      sectionName: "Login Flow",
      env: {},
      reportDir: join(root, "2026-10-13_15-40-08_cim-login-validation"),
      archiveRoot
    });

    expect(dest).toMatch(/archive_login-flow_\d{8}_\d{6}_[a-f0-9]+/);
    expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("alpha");
    expect(await readFile(join(dest, "nested", "b.txt"), "utf8")).toBe("beta");
    expect(await readFile(join(source, "a.txt"), "utf8")).toBe("alpha");
    expect(existsSync(join(source, "nested", "b.txt"))).toBe(true);
  });

  it("moves folder contents but keeps the location folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "solidflow-archive-"));
    const source = join(root, "payload");
    const archiveRoot = join(root, "archive");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "keep-path.txt"), "gone from source");

    const dest = await executeArchiveData({
      action: "move",
      location: "payload",
      flowDir: root,
      sectionName: "Export",
      env: {},
      reportDir: join(root, "run-folder"),
      archiveRoot
    });

    expect(await readFile(join(dest, "keep-path.txt"), "utf8")).toBe("gone from source");
    expect(existsSync(source)).toBe(true);
    expect(await readdir(source)).toEqual([]);
  });

  it("creates an archive folder when the location is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "solidflow-archive-"));
    const source = join(root, "empty");
    const archiveRoot = join(root, "archive");
    await mkdir(source, { recursive: true });

    const dest = await executeArchiveData({
      action: "copy",
      location: source,
      flowDir: root,
      sectionName: "Empty",
      env: {},
      reportDir: join(root, "run-folder"),
      archiveRoot
    });

    expect(existsSync(dest)).toBe(true);
    expect(await readdir(dest)).toEqual([]);
  });

  it("archives under the current run report folder by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "solidflow-archive-"));
    const reportDir = join(root, "2026-10-13_15-40-08_cim-login-validation");
    const source = join(root, "data");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "note.txt"), "run-scoped");

    const dest = await executeArchiveData({
      action: "copy",
      location: source,
      flowDir: root,
      sectionName: "Login",
      env: {},
      reportDir
    });

    expect(dest.startsWith(join(reportDir, "archive"))).toBe(true);
    expect(await readFile(join(dest, "note.txt"), "utf8")).toBe("run-scoped");
  });

  it("treats cut as move", async () => {
    const root = await mkdtemp(join(tmpdir(), "solidflow-archive-"));
    const source = join(root, "payload");
    const archiveRoot = join(root, "archive");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "item.txt"), "cut-me");

    const dest = await executeArchiveData({
      action: "CUT",
      location: source,
      flowDir: root,
      sectionName: "Cut",
      env: {},
      reportDir: join(root, "run"),
      archiveRoot
    });

    expect(await readFile(join(dest, "item.txt"), "utf8")).toBe("cut-me");
    expect(await readdir(source)).toEqual([]);
  });

  it("rejects invalid action and missing folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "solidflow-archive-"));
    await expect(
      executeArchiveData({
        action: "zip",
        location: root,
        flowDir: root,
        sectionName: "X",
        env: {},
        reportDir: join(root, "run"),
        archiveRoot: join(root, "archive")
      })
    ).rejects.toBeInstanceOf(FlowError);

    await expect(
      executeArchiveData({
        action: "copy",
        location: join(root, "missing"),
        flowDir: root,
        sectionName: "X",
        env: {},
        reportDir: join(root, "run"),
        archiveRoot: join(root, "archive")
      })
    ).rejects.toThrow(/does not exist/);
  });

  it("builds unique archive folder names", () => {
    const root = join(tmpdir(), "solidflow-archive-unique");
    const a = uniqueArchiveFolderName(root, "Login Flow", new Date("2026-10-13T10:05:42"));
    const b = uniqueArchiveFolderName(root, "Login Flow", new Date("2026-10-13T10:05:42"));
    expect(a).toMatch(/^archive_login-flow_20261013_100542_[a-f0-9]+$/);
    expect(a).not.toBe(b);
  });
});
