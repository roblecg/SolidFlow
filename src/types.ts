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
  steps: FlowStep[];
};

export type FlowStep =
  | string
  | Record<string, string | number | boolean | FlowStep[] | Record<string, unknown>>;

export type LocatorMatch = {
  strategy: "testId" | "id" | "text" | "role" | "partialText";
  value: string;
  confidence: number;
};

export type StepStatus = "passed" | "failed" | "skipped";

export type StepReport = {
  index: number;
  command: string;
  status: StepStatus;
  durationMs: number;
  error?: string;
  locator?: LocatorMatch;
  screenshot?: string;
};

export type RunReport = {
  runId: string;
  flowName: string;
  appId: string;
  driver: DriverKind;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed";
  device: DeviceInfo;
  steps: StepReport[];
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
