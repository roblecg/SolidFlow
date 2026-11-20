import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../src/studio/public/window-suggest.js", import.meta.url), "utf8");
const sandbox: { window: { SolidFlowWindows: WindowSuggest } } = { window: {} as { SolidFlowWindows: WindowSuggest } };
runInContext(script, createContext(sandbox));
const windows = sandbox.window.SolidFlowWindows;

type WindowSuggest = {
  switchFileContext(value: string, cursor: number): { typed: string; from: number; to: number } | null;
  trayMenuContext(value: string, cursor: number): { typed: string; from: number; to: number } | null;
  editorSuggestContext(
    value: string,
    cursor: number
  ): { kind: string; typed: string; from: number; to: number } | null;
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

  it("opens on trayMenu: and leaves switchToWindow file: alone", () => {
    const source = "- trayMenu:";
    const context = windows.trayMenuContext(source, source.length);
    expect(context).toMatchObject({ typed: "", from: source.length, to: source.length });
    expect(windows.editorSuggestContext(source, source.length)).toMatchObject({ kind: "tray-app", mode: "shorthand" });
    const partial = '- trayMenu: "Pro';
    expect(windows.trayMenuContext(partial, partial.length)?.typed).toBe("Pro");
    expect(windows.trayMenuContext("- launchApp", 4)).toBeNull();
    expect(windows.editorSuggestContext(flow, flow.indexOf("file:") + "file:".length)?.kind).toBe("window");
  });

  it("lists a taskbar app, then that app's menu item", () => {
    const source = '- trayMenu:\n    app: "Cursor"\n    item:';
    const appCaret = source.indexOf("\n    item:");
    expect(windows.editorSuggestContext(source, appCaret)).toMatchObject({
      kind: "tray-app",
      mode: "field",
      typed: "Cursor"
    });
    expect(windows.editorSuggestContext(source, source.length)).toMatchObject({
      kind: "tray-item",
      app: "Cursor",
      typed: ""
    });
    const other = "- runScript:\n    app: Cursor\n    item:";
    expect(windows.editorSuggestContext(other, other.length)).toBeNull();
  });

  it("keeps a plain file name and quotes a name that would break YAML", () => {
    expect(windows.yamlFileValue("AppUpdate.html")).toBe(" AppUpdate.html");
    expect(windows.yamlFileValue("Update available.html")).toBe(' "Update available.html"');
  });
});
