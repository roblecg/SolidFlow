import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceDir,
  createWorkspaceFile,
  listWorkspaceTree,
  resolveFlowPath,
  yamlStep
} from "../src/studio/files.js";
import {
  forgetWorkspace,
  rememberWorkspace,
  scaffoldSolidFlowWorkspace,
  setWorkspaceRoot,
  settingsFilePath,
  useSavedWorkspace,
  workspaceRoot
} from "../src/studio/workspace.js";
import { packageRoot } from "../src/util/paths.js";
import { appLog, clearAppLogs, formatStepLabel, listAppLogs } from "../src/studio/logs.js";
import { chooseSelector } from "../src/studio/session.js";

function captureWorkspace(): string | undefined {
  try {
    return workspaceRoot();
  } catch {
    return undefined;
  }
}

function restoreWorkspace(previous: string | undefined, previousEnv: string | undefined): void {
  if (previous) setWorkspaceRoot(previous);
  else forgetWorkspace();
  if (previousEnv === undefined) delete process.env.SOLIDFLOW_WORKSPACE;
  else process.env.SOLIDFLOW_WORKSPACE = previousEnv;
}

function restoreSettings(previousSettings: string | undefined): void {
  if (previousSettings === undefined) delete process.env.SOLIDFLOW_SETTINGS_PATH;
  else process.env.SOLIDFLOW_SETTINGS_PATH = previousSettings;
}

describe("studio files", () => {
  it("formats test log lines like a step list", () => {
    expect(formatStepLabel("waitForPopup")).toBe("Wait for the next window");
    expect(formatStepLabel("switchToMain")).toBe("Switch to the original window");
    expect(formatStepLabel('tapOn: "Sign in"')).toBe('Tap on "Sign in"');
    expect(formatStepLabel('tapOn: "login-region"')).toBe("Tap on id: login-region");
    expect(formatStepLabel('inputText: "login-tenantId|kddadev6"')).toBe(
      'Input text "kddadev6" into login-tenantId'
    );
  });

  it("filters app logs by keyword", () => {
    clearAppLogs();
    appLog("info", "Connected app session");
    appLog("error", "Run failed: timeout");
    expect(listAppLogs("timeout").map(entry => entry.message)).toEqual(["Run failed: timeout"]);
    expect(listAppLogs("error").map(entry => entry.level)).toEqual(["error"]);
    clearAppLogs();
  });

  it("quotes selectors that contain spaces", () => {
    expect(yamlStep("tapOn", "Select a region.")).toBe('- tapOn: "Select a region."');
    expect(yamlStep("tapOn", "login-region")).toBe("- tapOn: login-region");
  });

  it("records dropdown options by visible label, not generated ids", () => {
    expect(
      chooseSelector({
        role: "option",
        id: "cl-1-option-5",
        testId: "",
        name: "",
        text: "kddadev6"
      })
    ).toBe("role:option/kddadev6");
    expect(
      chooseSelector({
        role: "combobox",
        id: "login-region",
        testId: "",
        name: "",
        text: "Region"
      })
    ).toBe("login-region");
  });

  it("keeps flow paths inside the workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "solidFlow-paths-"));
    const previousEnv = process.env.SOLIDFLOW_WORKSPACE;
    const previous = captureWorkspace();
    setWorkspaceRoot(dir);
    try {
      expect(resolveFlowPath("flows/login-validation.yaml")).toMatch(/login-validation\.yaml$/);
      expect(() => resolveFlowPath("../package.json")).toThrow(/Invalid path/);
      expect(() => resolveFlowPath("package.json")).toThrow(/\.yaml/);
      expect(() => resolveFlowPath("C:/Windows/notepad.yaml")).toThrow(/Invalid path/);
    } finally {
      restoreWorkspace(previous, previousEnv);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat the application folder as a workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "solidFlow-noworkspace-"));
    const previousEnv = process.env.SOLIDFLOW_WORKSPACE;
    const previousSettings = process.env.SOLIDFLOW_SETTINGS_PATH;
    const previous = captureWorkspace();
    process.env.SOLIDFLOW_SETTINGS_PATH = join(dir, "settings.json");
    process.env.SOLIDFLOW_WORKSPACE = packageRoot();
    try {
      expect(() => setWorkspaceRoot(packageRoot())).toThrow(/outside the SolidFlow application/);
      expect(() => scaffoldSolidFlowWorkspace(packageRoot())).toThrow(/outside the SolidFlow application/);
      expect(useSavedWorkspace()).toEqual([]);
      expect(existsSync(join(packageRoot(), ".solidflow"))).toBe(false);
      expect(existsSync(join(packageRoot(), "flows"))).toBe(false);
    } finally {
      restoreWorkspace(previous, previousEnv);
      restoreSettings(previousSettings);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("switches and remembers a workspace folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "solidFlow-workspace-"));
    const settings = join(dir, "settings.json");
    const previousEnv = process.env.SOLIDFLOW_WORKSPACE;
    const previousSettings = process.env.SOLIDFLOW_SETTINGS_PATH;
    const previousRoot = captureWorkspace();
    process.env.SOLIDFLOW_SETTINGS_PATH = settings;
    try {
      expect(setWorkspaceRoot(dir)).toBe(resolve(dir));
      expect(resolveFlowPath("flows/a.yaml")).toBe(resolve(dir, "flows", "a.yaml"));
      expect(() => setWorkspaceRoot(join(dir, "missing"))).toThrow(/does not exist/);
      const saved = rememberWorkspace(dir);
      expect(saved.path).toBe(resolve(dir));
      expect(saved.created).toEqual([".solidflow/config.yaml", "flows", "README.md", "flows/example.yaml"]);
      expect(readFileSync(join(dir, "flows", "example.yaml"), "utf8")).toContain(
        'appPath: "C:/path/to/other-app.exe"'
      );
      expect(readFileSync(join(dir, ".solidflow", "config.yaml"), "utf8")).toContain("flows:");
      expect(rememberWorkspace(dir).created).toEqual([]);
      expect(JSON.parse(readFileSync(settingsFilePath(), "utf8")).workspacePath).toBe(resolve(dir));
    } finally {
      restoreWorkspace(previousRoot, previousEnv);
      restoreSettings(previousSettings);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists a SolidFlow workspace tree and does not overwrite existing flows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "solidFlow-tree-"));
    const previousEnv = process.env.SOLIDFLOW_WORKSPACE;
    const previousRoot = captureWorkspace();
    try {
      mkdirSync(join(dir, "auth"), { recursive: true });
      writeFileSync(join(dir, "auth", "login.yaml"), "appId: demo\n---\n- launchApp\n", "utf8");
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "pkg", "skip.yaml"), "nope\n", "utf8");
      mkdirSync(join(dir, ".maestro"), { recursive: true });
      writeFileSync(join(dir, ".maestro", "config.yaml"), "legacy: true\n", "utf8");
      const created = scaffoldSolidFlowWorkspace(dir);
      expect(created).toEqual(["flows", "README.md"]);
      expect(existsSync(join(dir, ".maestro"))).toBe(false);
      expect(readFileSync(join(dir, ".solidflow", "config.yaml"), "utf8")).toContain("legacy: true");
      expect(existsSync(join(dir, "flows", "example.yaml"))).toBe(false);
      setWorkspaceRoot(dir);
      const tree = await listWorkspaceTree();
      expect(tree.map(node => node.name)).toEqual([".solidflow", "auth", "flows", "README.md"]);
      const auth = tree.find(node => node.name === "auth");
      expect(auth?.children?.map(node => node.name)).toEqual(["login.yaml"]);
      const folder = await createWorkspaceDir("flows/regression");
      expect(folder).toBe("flows/regression");
      const file = await createWorkspaceFile("flows/regression/check");
      expect(file).toBe("flows/regression/check.yaml");
      await expect(createWorkspaceFile("../outside.yaml")).rejects.toThrow(/Invalid file name/);
      await expect(createWorkspaceDir("flows/../secret")).rejects.toThrow(/Invalid folder name/);
    } finally {
      restoreWorkspace(previousRoot, previousEnv);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
