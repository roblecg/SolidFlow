import { describe, expect, it } from "vitest";
import {
  classifyLaunchExit,
  parseProcessList,
  pidsToStop,
  type RunningProcess
} from "../src/driver/stop-app.js";

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

  it("stops the processes the app started and leaves the system browser", () => {
    const running = [
      proc({ pid: 50, name: "app.exe", created: 1_000 }),
      proc({ pid: 51, name: "helper.exe", parentPid: 50, created: 1_100 }),
      proc({ pid: 52, name: "worker.exe", parentPid: 51, created: 1_200 }),
      proc({ pid: 53, name: "old.exe", parentPid: 50, created: 500 }),
      proc({ pid: 54, name: "msedge.exe", parentPid: 50, created: 1_300 })
    ];
    expect(pidsToStop(running, { pid: 50, appPath: "C:/apps/app.exe" })).toEqual([50, 51, 52]);
  });
});

describe("process list", () => {
  it("reads the parent and start time", () => {
    const list = parseProcessList("10\tapp.exe\tC:\\apps\\app.exe\t\t4\t1700000000000\r\n11\told.exe\tC:\\old.exe\t\r\n");
    expect(list).toEqual([
      { pid: 10, name: "app.exe", executablePath: "C:\\apps\\app.exe", commandLine: "", parentPid: 4, created: 1_700_000_000_000 },
      { pid: 11, name: "old.exe", executablePath: "C:\\old.exe", commandLine: "" }
    ]);
  });
});

describe("launch exit", () => {
  const launch = { pid: 90, appPath: "C:/apps/cimdocumentexporter.exe", startedAt: 1_000, debugPort: 4567 };

  it("hands off to a copy that was already open", () => {
    const running = [proc({ pid: 70, name: "cimdocumentexporter.exe", created: 400 })];
    expect(classifyLaunchExit(running, launch)).toBe("handedOff");
  });

  it("keeps waiting when the exe started the real app", () => {
    expect(classifyLaunchExit([proc({ pid: 91, name: "real.exe", parentPid: 90, created: 1_050 })], launch)).toBe(
      "starting"
    );
    const webview = proc({
      pid: 92,
      name: "msedgewebview2.exe",
      commandLine: "--remote-debugging-port=4567",
      created: 1_200
    });
    expect(classifyLaunchExit([webview], launch)).toBe("starting");
  });

  it("reports a closed app when nothing else is running", () => {
    const running = [proc({ pid: 80, name: "notepad.exe", created: 100 })];
    expect(classifyLaunchExit(running, launch)).toBe("closed");
  });
});
