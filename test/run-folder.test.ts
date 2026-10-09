import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFolderName, uniqueRunFolder } from "../src/report/run-folder.js";

describe("run folders", () => {
  it("names a run with local time and the flow name", () => {
    const when = new Date(2026, 8, 25, 19, 23, 5);
    expect(runFolderName("CIM login validation", when)).toBe("2026-09-25_19-23-05_cim-login-validation");
    expect(runFolderName("  ", when)).toBe("2026-09-25_19-23-05_run");
  });

  it("adds a suffix when that folder already exists", () => {
    const root = mkdtempSync(join(tmpdir(), "solidflow-results-"));
    const when = new Date(2026, 8, 25, 19, 23, 5);
    try {
      mkdirSync(join(root, "2026-09-25_19-23-05_login"));
      expect(uniqueRunFolder(root, "Login", when)).toBe("2026-09-25_19-23-05_login_2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
