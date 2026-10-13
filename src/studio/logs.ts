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
  status: "running" | "passed" | "failed";
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

export function finishTestRun(runId: string, status: "passed" | "failed"): void {
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
  if (value.startsWith("role:option/")) return `${verb} "${value.slice("role:option/".length)}"`;
  const windowControl = windowControlLabel(value);
  if (windowControl) return `${verb} ${windowControl}`;
  if (name === "tapOn" && /^[\w.-]+$/.test(value)) return `Tap on id: ${value}`;
  if (!value) return verb;
  return `${verb} "${value}"`;
}
