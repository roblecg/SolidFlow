import { describe, expect, it } from "vitest";
import { pidsToStop, type RunningProcess } from "../src/driver/stop-app.js";

const kcps = "C:/Program Files/Kyocera/Kyocera Cloud Print and Scan/JcsUiAgent/JcsUiAgent.exe";
const profile = "C:/Users/me/AppData/Local/Temp/solidFlow-wv2-abc";

function proc(partial: Partial<RunningProcess> & Pick<RunningProcess, "pid" | "name">): RunningProcess {
  return { executablePath: "", commandLine: "", ...partial };
}

describe("pids to stop", () => {
  it("stops the launched process and other copies of that exe", () => {
    const running = [
      proc({ pid: 10, name: "JcsUiAgent.exe", executablePath: kcps }),
      proc({ pid: 11, name: "JcsUiAgent.exe" }),
      proc({ pid: 12, name: "notepad.exe", executablePath: "C:/Windows/notepad.exe" })
    ];
    expect(pidsToStop(running, { pid: 10, appPath: kcps })).toEqual([10, 11]);
  });

  it("stops WebView2 processes for that app and leaves other apps", () => {
    const running = [
      proc({
        pid: 20,
        name: "msedgewebview2.exe",
        commandLine: `--webview-exe-name=cimdocumentexporter.exe --user-data-dir="${profile}"`
      }),
      proc({
        pid: 21,
        name: "msedgewebview2.exe",
        commandLine: `--remote-debugging-port=9333 --user-data-dir="${profile}"`
      }),
      proc({
        pid: 22,
        name: "msedgewebview2.exe",
        commandLine: "--webview-exe-name=SolidFlow.exe --remote-debugging-port=93330"
      }),
      proc({ pid: 23, name: "StatusMonitorSvc.exe" }),
      proc({ pid: 24, name: "node.exe", commandLine: "node studio" })
    ];
    expect(
      pidsToStop(running, {
        pid: 19,
        appPath: "C:/apps/cimdocumentexporter.exe",
        userDataDir: profile,
        debugPort: 9333
      })
    ).toEqual([19, 20, 21]);
  });

  it("does not treat a shorter debugging port as the same port", () => {
    const running = [
      proc({ pid: 30, name: "msedgewebview2.exe", commandLine: "--remote-debugging-port=93330" })
    ];
    expect(pidsToStop(running, { debugPort: 9333, appPath: "C:/apps/app.exe" })).toEqual([]);
  });

  it("does not stop this process", () => {
    const running = [proc({ pid: 40, name: "JcsUiAgent.exe" })];
    expect(pidsToStop(running, { pid: 40, appPath: kcps }, [40])).toEqual([]);
  });
});
