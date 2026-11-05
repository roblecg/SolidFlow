import type { FlowSection, SectionStatus } from "../types.js";
import { sectionStatusFromSteps } from "../flow/sections.js";

export type AppLogEntry = {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
};

export type TestStepLog = {
  index: number;
  command: string;
  label: string;
  status: "running" | "passed" | "failed" | "skipped";
  durationMs?: number;
  error?: string;
  sectionNumber?: number;
  at?: string;
};

export type TestSectionDef = {
  number: number;
  name: string;
  description: string;
  stepIndices: number[];
};

export type TestSectionLog = {
  number: number;
  name: string;
  description: string;
  status: SectionStatus;
  completedSteps: number;
  totalSteps: number;
  steps: TestStepLog[];
  failure?: {
    command: string;
    error: string;
    timestamp: string;
  };
};

export type TestRunLog = {
  id: string;
  name: string;
  path: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed" | "stopped";
  steps: TestStepLog[];
  sectionDefs: TestSectionDef[];
};

const appLogs: AppLogEntry[] = [];
const testRuns: TestRunLog[] = [];
const MAX_APP_LOGS = 400;
const MAX_RUNS = 30;

export function appLog(level: AppLogEntry["level"], message: string): void {
  appLogs.push({ at: new Date().toISOString(), level, message });
  if (appLogs.length > MAX_APP_LOGS) appLogs.splice(0, appLogs.length - MAX_APP_LOGS);
}

export function listAppLogs(query?: string): AppLogEntry[] {
  const needle = query?.trim().toLowerCase();
  const rows = needle
    ? appLogs.filter(entry => entry.message.toLowerCase().includes(needle) || entry.level.includes(needle))
    : appLogs;
  return rows.slice().reverse();
}

export function clearAppLogs(): void {
  appLogs.length = 0;
}

export function beginTestRun(
  id: string,
  name: string,
  path: string,
  sections: FlowSection[] = []
): TestRunLog {
  const run: TestRunLog = {
    id,
    name,
    path,
    startedAt: new Date().toISOString(),
    status: "running",
    steps: [],
    sectionDefs: sections.map(section => ({
      number: section.number,
      name: section.name,
      description: section.description,
      stepIndices: [...section.stepIndices]
    }))
  };
  testRuns.push(run);
  if (testRuns.length > MAX_RUNS) testRuns.splice(0, testRuns.length - MAX_RUNS);
  return run;
}

export function noteTestStep(
  runId: string,
  step: Omit<TestStepLog, "label"> & { label?: string }
): void {
  const run = testRuns.find(item => item.id === runId);
  if (!run) return;
  const label = step.label ?? formatStepLabel(step.command);
  const existing = run.steps.find(item => item.index === step.index);
  if (existing) {
    existing.status = step.status;
    existing.durationMs = step.durationMs ?? existing.durationMs;
    existing.error = step.error;
    existing.label = label;
    existing.sectionNumber = step.sectionNumber ?? existing.sectionNumber;
    existing.at = step.at ?? existing.at ?? new Date().toISOString();
    return;
  }
  run.steps.push({
    ...step,
    label,
    at: step.at ?? new Date().toISOString()
  });
}

export function finishTestRun(runId: string, status: "passed" | "failed" | "stopped"): void {
  const run = testRuns.find(item => item.id === runId);
  if (!run) return;
  run.status = status;
  run.finishedAt = new Date().toISOString();
}

function liveSections(run: TestRunLog): TestSectionLog[] {
  const runFinished = run.status !== "running";
  return [...run.sectionDefs]
    .sort((a, b) => a.number - b.number)
    .map(section => {
      const liveSteps = section.stepIndices
        .map(index => run.steps.find(step => step.index === index))
        .filter((step): step is TestStepLog => Boolean(step));
      const totalSteps = section.stepIndices.length;
      const status = sectionStatusFromSteps(liveSteps, totalSteps, runFinished);
      const failedStep = liveSteps.find(step => step.status === "failed");
      return {
        number: section.number,
        name: section.name,
        description: section.description,
        status,
        completedSteps: liveSteps.filter(s => s.status === "passed" || s.status === "failed").length,
        totalSteps,
        steps: liveSteps,
        failure: failedStep
          ? {
              command: failedStep.command,
              error: failedStep.error ?? "failed",
              timestamp: failedStep.at ?? run.finishedAt ?? new Date().toISOString()
            }
          : undefined
      };
    });
}

export function listTestRuns(): Array<TestRunLog & { sections: TestSectionLog[] }> {
  return testRuns
    .slice()
    .reverse()
    .map(run => ({
      ...run,
      sections: liveSections(run)
    }));
}

export function clearTestRuns(): void {
  testRuns.length = 0;
}

function switchBrowserLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return "Switch to the browser";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed == null) return "Switch to the browser";
    if (typeof parsed === "string" && parsed.trim()) return `Switch to the browser at ${parsed.trim()}`;
    if (parsed && typeof parsed === "object") {
      const url = (parsed as { url?: unknown }).url;
      if (typeof url === "string" && url.trim()) return `Switch to the browser at ${url.trim()}`;
      return "Switch to the browser";
    }
  } catch {
    // The log line is already plain text.
  }
  const plain = trimmed.replace(/^"|"$/g, "").trim();
  return plain ? `Switch to the browser at ${plain}` : "Switch to the browser";
}

function switchWindowLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Switch to window";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return `Switch to window "${parsed}"`;
    if (parsed && typeof parsed === "object") {
      const record = parsed as { file?: unknown; title?: unknown; text?: unknown };
      const name = [record.file, record.title, record.text].find(item => typeof item === "string" && item);
      if (typeof name === "string") return `Switch to window "${name}"`;
    }
  } catch {
    // The log line is already plain text.
  }
  return `Switch to window "${trimmed.replace(/^"|"$/g, "")}"`;
}

function trayMenuLabel(raw: string): string {
  const trimmed = raw.trim();
  let item = trimmed;
  let app = "";
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { item?: unknown; app?: unknown };
      if (typeof parsed.item === "string") item = parsed.item;
      if (typeof parsed.app === "string") app = parsed.app.trim();
    } catch {
      item = trimmed;
    }
  } else if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      item = JSON.parse(trimmed) as string;
    } catch {
      item = trimmed.slice(1, -1);
    }
  }
  item = item.trim();
  if (app && item) return `Open "${item}" from ${app} on the taskbar`;
  return item ? `Open "${item}" from the taskbar` : "Open the taskbar menu";
}

function windowControlLabel(value: string): string | null {
  const labels: Record<string, string> = {
    "window:close": "Close",
    "window:minimize": "Minimize",
    "window:maximize": "Maximize",
    "window:restore": "Restore",
    "window:title": "the window title bar"
  };
  return labels[value] ?? null;
}

export function formatStepLabel(command: string): string {
  if (command === "launchApp") return "Launch app";
  if (command === "stopApp") return "Stop app";
  if (command === "clearState") return "Clear app state";
  if (command === "waitForPopup" || command.startsWith("waitForPopup")) return "Wait for the next window";
  if (command === "switchToMain") return "Switch to the original window";
  if (command === "switchToBrowser" || command.startsWith("switchToBrowser")) {
    return switchBrowserLabel(command.slice("switchToBrowser".length).replace(/^:\s*/, ""));
  }
  if (command === "switchToWindow" || command.startsWith("switchToWindow")) {
    return switchWindowLabel(command.slice("switchToWindow".length).replace(/^:\s*/, ""));
  }
  if (command === "trayMenu" || command.startsWith("trayMenu")) {
    return trayMenuLabel(command.slice("trayMenu".length).replace(/^:\s*/, ""));
  }
  const match = /^(\w+):\s*([\s\S]*)$/.exec(command);
  if (!match) return command;
  const name = match[1] ?? command;
  let value = (match[2] ?? "").trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      value = value.slice(1, -1);
    }
  }
  const verbs: Record<string, string> = {
    tapOn: "Tap on",
    doubleTap: "Double tap",
    doubleTapOn: "Double tap",
    longPress: "Long press",
    longPressOn: "Long press",
    scrollUntilVisible: "Scroll until visible",
    extendedWaitUntil: "Wait until",
    copyTextFrom: "Copy text from",
    pressKey: "Press key",
    openLink: "Open link",
    evalScript: "Eval script",
    runScript: "Run script",
    assertTrue: "Assert true",
    inputText: "Input text",
    eraseText: "Erase text",
    assertVisible: "Assert visible",
    assertNotVisible: "Assert not visible",
    waitForVisible: "Wait until visible",
    waitForHidden: "Wait until hidden",
    takeScreenshot: "Take screenshot",
    executeScript: "Run script",
    scroll: "Scroll",
    swipe: "Swipe",
    assertText: "Assert text"
  };
  const verb = verbs[name] ?? name;
  if (name === "inputText" && value.includes("|")) {
    const splitAt = value.indexOf("|");
    const target = value.slice(0, splitAt);
    const text = value.slice(splitAt + 1);
    return `Input text "${text}" into ${target}`;
  }
  const namedRole = /^role:(?:option|radio|checkbox|switch)\/([\s\S]+)$/.exec(value);
  if (namedRole) return `${verb} "${namedRole[1]}"`;
  const windowControl = windowControlLabel(value);
  if (windowControl) return `${verb} ${windowControl}`;
  if (name === "tapOn" && /^[\w.-]+$/.test(value)) return `Tap on id: ${value}`;
  if (!value) return verb;
  return `${verb} "${value}"`;
}
