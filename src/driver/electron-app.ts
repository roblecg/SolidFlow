import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const ELECTRON_MARKERS = [
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "resources.pak",
  "icudtl.dat",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "ffmpeg.dll",
  "libEGL.dll"
];

/** Packaged Electron layout (electron-packager / electron-builder), not WebView2 or Tauri. */
export function isElectronApp(appPath: string): boolean {
  const dir = dirname(appPath);
  const hits = ELECTRON_MARKERS.filter(name => existsSync(join(dir, name))).length;
  const resources = join(dir, "resources");
  const packed = existsSync(join(resources, "app.asar")) || existsSync(join(resources, "app"));
  return hits >= 3 && packed;
}

export function isKcpsDesktop(appPath: string): boolean {
  const name = basename(appPath).toLowerCase();
  if (name === "jcsuiagent.exe") return true;
  return basename(dirname(appPath)).toLowerCase() === "jcsuiagent";
}

/** Installer builds are named cloudprintscan_*.exe. The desktop UI is JcsUiAgent.exe. */
export function kcpsInstallerHint(appPath: string): string | undefined {
  const name = basename(appPath).toLowerCase();
  if (!name.startsWith("cloudprintscan") || isElectronApp(appPath)) return undefined;
  return (
    "This file is the Cloud Print and Scan installer, not the desktop app. " +
    "Set appPath to the installed JcsUiAgent.exe, usually " +
    "C:/Program Files/Kyocera/Kyocera Cloud Print and Scan/JcsUiAgent/JcsUiAgent.exe"
  );
}

export function electronLaunchArgs(port: number, userDataDir: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`
  ];
}

export function isAppPageUrl(url: string): boolean {
  if (!url || url === "about:blank") return false;
  if (url.startsWith("devtools://") || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
    return false;
  }
  return true;
}

export function electronExitMessage(appPath: string, code: number | null, signal: NodeJS.Signals | null): string {
  const how = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
  const base = `Electron app exited before a window opened (${how}).`;
  if (!isKcpsDesktop(appPath)) return base;
  return (
    `${base} Close any Kyocera Cloud Print and Scan tray icon first. ` +
    "The window also waits for StatusMonitorSvc at http://127.0.0.1:5570."
  );
}

export function electronWindowTimeoutMessage(appPath: string, port: number): string {
  const base = `Electron app did not open a window on port ${port}.`;
  if (!isKcpsDesktop(appPath)) return base;
  return (
    `${base} Kyocera Cloud Print and Scan stays in the tray until StatusMonitorSvc answers at http://127.0.0.1:5570. ` +
    "Start that service, then run the flow again."
  );
}
