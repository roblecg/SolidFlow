export type DriverKind = "webview2" | "chromium" | "android" | "ios" | "browser";

export type FlowDocument = {
  appId: string;
  /** Full path to the desktop exe this flow launches. */
  appPath?: string;
  name?: string;
  tags?: string[];
  locale?: string;
  env?: Record<string, string>;
  driver?: DriverKind;
  /** Flattened executable commands (section wrappers expanded). */
  steps: FlowStep[];
  /** Logical groupings over `steps`, including Unassigned (0) when needed. */
  sections?: FlowSection[];
};

export type FlowStep =
  | string
  | Record<string, string | number | boolean | FlowStep[] | Record<string, unknown>>;

/** Metadata for a named (or Unassigned) group of flattened steps. */
export type FlowSection = {
  number: number;
  name: string;
  description: string;
  /** Indices into FlowDocument.steps / StepReport.index */
  stepIndices: number[];
};

export type LocatorMatch = {
  strategy: "testId" | "id" | "text" | "role" | "partialText";
  value: string;
  confidence: number;
};

export type StepStatus = "passed" | "failed" | "skipped";

export type SectionStatus = "passed" | "failed" | "skipped" | "running" | "pending";

export type StepReport = {
  index: number;
  command: string;
  status: StepStatus;
  durationMs: number;
  error?: string;
  locator?: LocatorMatch;
  screenshot?: string;
  sectionNumber?: number;
};

export type SectionReport = {
  number: number;
  name: string;
  description: string;
  status: SectionStatus;
  completedSteps: number;
  totalSteps: number;
  steps: StepReport[];
  failure?: {
    command: string;
    error: string;
    timestamp: string;
  };
};

export type RunReport = {
  runId: string;
  flowName: string;
  appId: string;
  driver: DriverKind;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed" | "stopped";
  device: DeviceInfo;
  steps: StepReport[];
  sections: SectionReport[];
  reportDir: string;
};

export type DeviceInfo = {
  platform: string;
  hostname: string;
  driver: DriverKind;
  appPath?: string;
  debugPort?: number;
};

export type RunOptions = {
  tags?: string[];
  nameFilter?: string;
  env?: Record<string, string>;
  stepRetry?: number;
  runRetry?: number;
  reportDir?: string;
  cwd?: string;
  headless?: boolean;
  /** Pause around each action so the window can be watched. 0 keeps runs instant. */
  paceMs?: number;
};

export class DriverNotAvailableError extends Error {
  constructor(driver: DriverKind) {
    super(`Driver "${driver}" is not available in this build. See docs/architecture.md.`);
    this.name = "DriverNotAvailableError";
  }
}

export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

export class RunStoppedError extends Error {
  constructor(message = "Test stopped by user") {
    super(message);
    this.name = "RunStoppedError";
  }
}
