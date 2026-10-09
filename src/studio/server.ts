import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { exec } from "node:child_process";
import { packageRoot } from "../util/paths.js";
import { newRunId } from "../util/ids.js";
import {
  appLog,
  beginTestRun,
  clearAppLogs,
  clearTestRuns,
  finishTestRun,
  listAppLogs,
  listTestRuns,
  noteTestStep
} from "./logs.js";
import { resolveAppPath } from "../config.js";
import { listCommands } from "../flow/commands.js";
import { parseFlowContent, parseFlowFile } from "../flow/parser.js";
import { runFlowFile, type DriverSlot } from "../flow/runner.js";
import {
  createWorkspaceDir,
  createWorkspaceFile,
  listWorkspaceTree,
  readFlow,
  resolveFlowPath,
  revealWorkspacePath,
  workspaceRoot,
  writeFlow
} from "./files.js";
import {
  rememberWorkspace,
  reportRoot,
  useSavedWorkspace,
  workspaceChosen,
  workspaceConfig,
  workspaceStatus
} from "./workspace.js";
import {
  adoptDriver,
  borrowDriver,
  clearRunPreview,
  drainRecordedLines,
  pickAt,
  publishRunPreview,
  setRecordingPaused,
  snapshot,
  startSession,
  stopSession
} from "./session.js";

const STUDIO_PACE_MS = 700;

type LiveRun = {
  running: boolean;
  command: string;
  status: string;
  log: string[];
};

const liveRun: LiveRun = { running: false, command: "", status: "idle", log: [] };

const PUBLIC_DIR = join(packageRoot(), "src/studio/public");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

export async function startStudio(port = 4317, options: { openBrowser?: boolean } = {}): Promise<void> {
  const initialized = useSavedWorkspace();
  if (workspaceChosen()) {
    appLog("info", `Workspace ${workspaceRoot()}`);
    if (initialized.length > 0) {
      appLog("info", `Initialized SolidFlow workspace: ${initialized.join(", ")}`);
    }
  } else {
    appLog("info", "Select a workspace folder outside the SolidFlow application.");
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(err => {
      const message = err instanceof Error ? err.message : String(err);
      appLog("error", message);
      sendJson(res, 500, { error: message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const url = `http://127.0.0.1:${port}`;
  appLog("info", `SolidFlow listening on ${url}`);
  console.log(`SolidFlow: ${url}`);
  if (options.openBrowser === false) {
    console.log("Running inside the SolidFlow window.");
  } else {
    console.log("Press Ctrl+C to stop.");
    if (process.platform === "win32") {
      exec(`start "" "${url}"`);
    }
  }

  await new Promise<void>(resolve => {
    const shutdown = () => {
      void stopSession().finally(() => {
        server.close(() => resolve());
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/api/workspace") {
    sendJson(res, 200, workspaceStatus());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/workspace") {
    if (liveRun.running) {
      sendJson(res, 409, { error: "A test is running. Wait for it to finish before changing the workspace." });
      return;
    }
    const body = await readBody<{ path?: string }>(req);
    if (!body.path) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const saved = rememberWorkspace(body.path);
    appLog("info", `Workspace changed to ${saved.path}`);
    if (saved.created.length > 0) {
      appLog("info", `Initialized SolidFlow workspace: ${saved.created.join(", ")}`);
    }
    sendJson(res, 200, { ...workspaceStatus(), created: saved.created });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/tree") {
    if (!workspaceChosen()) {
      sendJson(res, 200, { name: "Workspace", children: [] });
      return;
    }
    sendJson(res, 200, { name: workspaceRoot().split(/[/\\]/).pop() ?? "workspace", children: await listWorkspaceTree() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/folder") {
    if (rejectWithoutWorkspace(res)) return;
    const body = await readBody<{ path?: string }>(req);
    if (!body.path) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const path = await createWorkspaceDir(body.path);
    appLog("info", `Created folder ${path}`);
    sendJson(res, 200, { path });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/reveal") {
    if (rejectWithoutWorkspace(res)) return;
    const body = await readBody<{ path?: string }>(req);
    revealWorkspacePath(body.path ?? "");
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/file") {
    if (rejectWithoutWorkspace(res)) return;
    const path = url.searchParams.get("path") ?? "";
    sendJson(res, 200, { path, content: await readFlow(path) });
    return;
  }
  if (req.method === "PUT" && url.pathname === "/api/file") {
    if (rejectWithoutWorkspace(res)) return;
    const body = await readBody<{ path?: string; content?: string }>(req);
    if (!body.path || body.content === undefined) {
      sendJson(res, 400, { error: "path and content are required" });
      return;
    }
    await writeFlow(body.path, body.content);
    appLog("info", `Saved flow ${body.path}`);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/file") {
    if (rejectWithoutWorkspace(res)) return;
    const body = await readBody<{ path?: string; name?: string }>(req);
    const requested = body.path || (body.name ? `flows/${body.name}` : "");
    if (!requested) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const path = await createWorkspaceFile(requested);
    appLog("info", `Created file ${path}`);
    sendJson(res, 200, { path });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/run") {
    if (rejectWithoutWorkspace(res)) return;
    const body = await readBody<{ path?: string; content?: string }>(req);
    if (!body.path) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    if (body.content !== undefined) {
      await writeFlow(body.path, body.content);
    }
    await setRecordingPaused(true);
    const slot: DriverSlot = { current: borrowDriver() };
    const config = workspaceConfig();
    liveRun.running = true;
    liveRun.log = [];
    liveRun.status = "running";
    liveRun.command = "Starting…";
    const runId = newRunId();
    const fileName = body.path.split("/").pop()?.replace(/\.ya?ml$/i, "") ?? body.path;
    let flowName = fileName;
    try {
      flowName = parseFlowFile(resolveFlowPath(body.path)).name || fileName;
    } catch {
      // The runner reports the parse error. Keep the file name on the log row.
    }
    beginTestRun(runId, flowName, body.path);
    appLog("info", `Run started: ${body.path}`);
    try {
      const report = await runFlowFile(resolveFlowPath(body.path), {
        reportDir: reportRoot(),
        cwd: workspaceRoot(),
        headless: false,
        paceMs: STUDIO_PACE_MS,
        keepDriver: true,
        driverSlot: slot,
        onStep: event => {
          liveRun.command = event.command;
          liveRun.status = event.status;
          liveRun.log.push(`${event.status}: ${event.command}`);
          noteTestStep(runId, event);
        },
        onPreview: publishRunPreview
      }, resolveAppPath(config));
      finishTestRun(runId, report.status);
      appLog(report.status === "passed" ? "info" : "error", `Run ${report.status}: ${body.path}`);
      liveRun.status = report.status;
      sendJson(res, 200, {
        status: report.status,
        reportDir: report.reportDir,
        steps: report.steps.map(step => ({
          command: step.command,
          status: step.status,
          error: step.error,
          durationMs: step.durationMs
        }))
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finishTestRun(runId, "failed");
      appLog("error", `Run failed: ${message}`);
      liveRun.status = "failed";
      sendJson(res, 200, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      liveRun.running = false;
      adoptDriver(slot.current);
      clearRunPreview();
      await setRecordingPaused(false);
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/commands") {
    sendJson(res, 200, { commands: listCommands(url.searchParams.get("selector") ?? "") });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/logs") {
    const kind = url.searchParams.get("kind") ?? "test";
    if (kind === "app") {
      sendJson(res, 200, { entries: listAppLogs(url.searchParams.get("q") ?? "") });
    } else {
      sendJson(res, 200, { runs: listTestRuns() });
    }
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/api/logs") {
    const kind = url.searchParams.get("kind") ?? "test";
    if (kind === "app") {
      clearAppLogs();
    } else {
      clearTestRuns();
      appLog("info", "Cleared test logs");
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/logs") {
    const body = await readBody<{ level?: "info" | "warn" | "error"; message?: string }>(req);
    if (body.message) appLog(body.level ?? "info", body.message);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/run/live") {
    sendJson(res, 200, liveRun);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/record") {
    sendJson(res, 200, { lines: await drainRecordedLines() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/record/pause") {
    const body = await readBody<{ paused?: boolean }>(req);
    await setRecordingPaused(body.paused !== false);
    sendJson(res, 200, { paused: body.paused !== false });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/pick") {
    const body = await readBody<{ nx?: number; ny?: number }>(req);
    const node = await pickAt(Number(body.nx), Number(body.ny));
    sendJson(res, 200, node ?? { selector: "" });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/session") {
    const body = await readBody<{ target?: "app" | "fixture"; path?: string; content?: string }>(req);
    const next = body.target === "fixture" ? "fixture" : "app";
    let flowAppPath: string | undefined;
    if (next === "app") {
      if (!body.content?.trim()) {
        sendJson(res, 400, { error: "Open a flow and set appPath to the exe you want to connect." });
        return;
      }
      flowAppPath = parseFlowContent(body.content, body.path || "flow").appPath;
    }
    await startSession(next, flowAppPath);
    appLog("info", `Connected ${next} session`);
    sendJson(res, 200, await snapshot());
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/api/session") {
    await stopSession();
    appLog("info", "Disconnected device session");
    sendJson(res, 200, { connected: false, target: null, nodes: [] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/session") {
    sendJson(res, 200, await snapshot());
    return;
  }
  if (req.method === "GET") {
    await serveStatic(url.pathname, res);
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const name = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (name.includes("..")) {
    sendJson(res, 400, { error: "Bad path" });
    return;
  }
  const file = join(PUBLIC_DIR, name);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function rejectWithoutWorkspace(res: ServerResponse): boolean {
  if (workspaceChosen()) return false;
  sendJson(res, 409, { error: "Select a workspace folder outside the SolidFlow application." });
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
