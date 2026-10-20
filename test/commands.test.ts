import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAESTRO_COMMAND_NAMES,
  canonicalCommand,
  listCommands,
  unavailableReason
} from "../src/flow/commands.js";
import { runFlowDocument } from "../src/flow/runner.js";

describe("maestro command catalog", () => {
  it("includes every command from the current Maestro reference", () => {
    const names = new Set(listCommands().map(command => command.name));
    for (const name of MAESTRO_COMMAND_NAMES) {
      expect(names.has(name), name).toBe(true);
    }
    expect(MAESTRO_COMMAND_NAMES).toHaveLength(48);
  });

  it("quotes selectors and keeps plain ids bare", () => {
    const commands = listCommands("Sign in");
    expect(commands.find(command => command.name === "tapOn")?.yaml).toBe('- tapOn: "Sign in"');
    expect(listCommands("login-region").find(command => command.name === "tapOn")?.yaml).toBe(
      "- tapOn: login-region"
    );
    expect(commands.find(command => command.name === "scrollUntilVisible")?.yaml).toContain(
      'element: "Sign in"'
    );
  });

  it("accepts Maestro aliases and explains desktop limits", () => {
    expect(canonicalCommand("doubleTap")).toBe("doubleTapOn");
    expect(canonicalCommand("longPress")).toBe("longPressOn");
    expect(unavailableReason("addMedia")).toMatch(/gallery/i);
    expect(unavailableReason("setAirplaneMode")).toMatch(/network/i);
    expect(listCommands().filter(command => !command.available).length).toBeGreaterThan(0);
    expect(listCommands().some(command => command.name === "waitForPopup")).toBe(true);
    expect(listCommands().some(command => command.name === "switchToMain")).toBe(true);
  });

  it("rejects a device-only command before launching a browser", async () => {
    const reportDir = await mkdtemp(join(tmpdir(), "solidFlow-cmd-"));
    try {
      await expect(
        runFlowDocument(
          {
            appId: "demo.app",
            driver: "chromium",
            steps: ["addMedia"]
          },
          { reportDir, headless: true }
        )
      ).rejects.toThrow(/photo gallery/);
    } finally {
      await rm(reportDir, { recursive: true, force: true });
    }
  });
});
