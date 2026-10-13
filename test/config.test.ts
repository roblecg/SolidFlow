import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("workspace config", () => {
  it("reads appPath from .solidflow/config.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "solidflow-config-"));
    try {
      mkdirSync(join(dir, ".solidflow"));
      writeFileSync(
        join(dir, ".solidflow", "config.yaml"),
        'appPath: "C:/apps/exporter.exe"\ndefaultLocale: en\n',
        "utf8"
      );
      expect(loadConfig(dir)).toMatchObject({
        appPath: "C:/apps/exporter.exe",
        defaultLocale: "en"
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps appPath from solidFlow.config.yaml when the scaffolded config does not set it", () => {
    const dir = mkdtempSync(join(tmpdir(), "solidflow-config-"));
    try {
      mkdirSync(join(dir, ".solidflow"));
      writeFileSync(join(dir, ".solidflow", "config.yaml"), 'defaultLocale: ja\nflows:\n  - "flows/**"\n', "utf8");
      writeFileSync(
        join(dir, "solidFlow.config.yaml"),
        'appPath: "C:/apps/legacy.exe"\ndefaultLocale: en\n',
        "utf8"
      );
      expect(loadConfig(dir)).toMatchObject({
        appPath: "C:/apps/legacy.exe",
        defaultLocale: "ja"
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
