import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../src/studio/public/window-suggest.js", import.meta.url), "utf8");
const sandbox: { window: { SolidFlowWindows: WindowSuggest } } = { window: {} as { SolidFlowWindows: WindowSuggest } };
runInContext(script, createContext(sandbox));
const windows = sandbox.window.SolidFlowWindows;

type WindowSuggest = {
  switchFileContext(value: string, cursor: number): { typed: string; from: number; to: number } | null;
  yamlFileValue(file: string): string;
};

const flow = `- launchApp
- switchToWindow:
    file:
- runScript:
    file: script.js
`;

describe("switchToWindow file suggestions", () => {
  it("opens on file: under switchToWindow", () => {
    const caret = flow.indexOf("file:") + "file:".length;
    expect(windows.switchFileContext(flow, caret)).toMatchObject({ typed: "", from: caret, to: caret });
  });

  it("filters by the text typed after the colon", () => {
    const source = "- switchToWindow:\n    file: App";
    const caret = source.length;
    const context = windows.switchFileContext(source, caret);
    expect(context?.typed).toBe("App");
    expect(source.slice(context!.from, context!.to)).toBe(" App");
  });

  it("stays closed for runScript and for the file key itself", () => {
    const scriptCaret = flow.lastIndexOf("file:") + "file:".length;
    expect(windows.switchFileContext(flow, scriptCaret)).toBeNull();
    const key = flow.indexOf("file:");
    expect(windows.switchFileContext(flow, key + 2)).toBeNull();
  });

  it("keeps a plain file name and quotes a name that would break YAML", () => {
    expect(windows.yamlFileValue("AppUpdate.html")).toBe(" AppUpdate.html");
    expect(windows.yamlFileValue("Update available.html")).toBe(' "Update available.html"');
  });
});
