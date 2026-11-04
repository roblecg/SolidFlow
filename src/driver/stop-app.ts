import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RunningProcess = {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
};

export type StopTarget = {
  pid?: number;
  appPath?: string;
  userDataDir?: string;
  debugPort?: number;
};

/** Windows services and this Studio process. A name match must not reach them. */
const PROTECTED = new Set([
  "system",
  "idle",
  "registry",
  "smss.exe",
  "csrss.exe",
  "wininit.exe",
  "winlogon.exe",
  "services.exe",
  "lsass.exe",
  "svchost.exe",
  "fontdrvhost.exe",
  "dwm.exe",
  "explorer.exe",
  "sihost.exe",
  "taskhostw.exe",
  "node.exe",
  "powershell.exe",
  "pwsh.exe",
  "cmd.exe",
  "conhost.exe",
  "solidflow.exe",
  "msedge.exe",
  "msedgewebview2.exe",
  "statusmonitorsvc.exe",
  "ippcom.exe"
]);

/** Processes whose command line can still identify the app we launched. */
const COMMAND_MATCH = new Set(["msedge.exe", "msedgewebview2.exe"]);

/**
 * Pids to terminate for one connected app.
 * The launched pid, every remaining copy of that exe, and WebView2 or Chromium
 * processes started for its profile or debugging port.
 */
export function pidsToStop(
  running: readonly RunningProcess[],
  target: StopTarget,
  exclude: readonly number[] = []
): number[] {
  const appName = target.appPath ? basename(target.appPath) : "";
  const appPath = target.appPath ?? "";
  const data = target.userDataDir && target.userDataDir.length >= 8 ? target.userDataDir : "";
  const excluded = new Set(exclude.filter(pid => pid > 0));
  const chosen: number[] = [];
  const seen = new Set<number>();
  const add = (pid: number | undefined) => {
    if (!pid || pid <= 0 || excluded.has(pid) || seen.has(pid)) return;
    seen.add(pid);
    chosen.push(pid);
  };
  add(target.pid);
  for (const proc of running) {
    if (belongsToApp(proc, appName, appPath, data, target.debugPort)) add(proc.pid);
  }
  return chosen;
}

export async function stopLaunchedApp(target: StopTarget): Promise<void> {
  const exclude = [process.pid, process.ppid ?? 0];
  const running = process.platform === "win32" ? await listProcesses() : [];
  for (const pid of pidsToStop(running, target, exclude)) {
    await killPid(pid);
  }
}

function belongsToApp(
  proc: RunningProcess,
  appName: string,
  appPath: string,
  userDataDir: string,
  debugPort: number | undefined
): boolean {
  const name = proc.name.trim().toLowerCase();
  if (!name || (PROTECTED.has(name) && !COMMAND_MATCH.has(name))) return false;
  if (!PROTECTED.has(name)) {
    if (appName && name === appName.toLowerCase()) return true;
    if (appPath && samePath(proc.executablePath, appPath)) return true;
  }
  const commandLine = proc.commandLine;
  if (!commandLine) return false;
  if (userDataDir && commandLine.includes(userDataDir)) return true;
  if (debugPort && debugPort > 0 && hasDebuggingPort(commandLine, debugPort)) return true;
  if (appName && commandLine.toLowerCase().includes(`--webview-exe-name=${appName.toLowerCase()}`)) return true;
  return false;
}

function samePath(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function hasDebuggingPort(commandLine: string, port: number): boolean {
  const marker = `--remote-debugging-port=${port}`;
  let from = 0;
  while (from < commandLine.length) {
    const at = commandLine.indexOf(marker, from);
    if (at < 0) return false;
    const next = commandLine[at + marker.length];
    if (!next || next === " " || next === '"' || next === "'") return true;
    from = at + marker.length;
  }
  return false;
}

async function killPid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

const LIST_PROCESSES = [
  "function Clean([string]$value) {",
  "  if (-not $value) { return '' }",
  "  return $value.Replace([char]9, ' ').Replace([char]10, ' ').Replace([char]13, ' ')",
  "}",
  "Get-CimInstance Win32_Process | ForEach-Object {",
  "  $cmd = [string]$_.CommandLine",
  "  if ($cmd -notmatch 'solidFlow-|--remote-debugging-port=|--webview-exe-name=') { $cmd = '' }",
  "  Write-Output (\"{0}`t{1}`t{2}`t{3}\" -f $_.ProcessId, (Clean $_.Name), (Clean $_.ExecutablePath), (Clean $cmd))",
  "}"
].join("; ");

async function listProcesses(): Promise<RunningProcess[]> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", LIST_PROCESSES],
      { windowsHide: true, timeout: 8_000, maxBuffer: 4 * 1024 * 1024 }
    );
    return String(stdout)
      .split(/\r?\n/)
      .map(parseProcessLine)
      .filter((proc): proc is RunningProcess => proc !== null);
  } catch {
    return [];
  }
}

function parseProcessLine(line: string): RunningProcess | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const [pidText, name = "", executablePath = "", commandLine = ""] = trimmed.split("\t");
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, name, executablePath, commandLine };
}
