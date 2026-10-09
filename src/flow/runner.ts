import { mkdir, readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type {
  FlowDocument,
  FlowStep,
  LocatorMatch,
  RunOptions,
  RunReport,
  StepReport
} from "../types.js";
import { FlowError } from "../types.js";
import { parseStep } from "./steps.js";
import { parseFlowFile } from "./parser.js";
import { createDriver, inferDriver } from "../driver/registry.js";
import { defaultLocatorResolver } from "../driver/locator.js";
import type { AutomationDriver } from "../driver/types.js";
import { loadConfigFromAncestors, resolveAppPath, shellAllowed } from "../config.js";
import { fixturePageUrl } from "../util/paths.js";
import { interpolateEnv } from "../util/ids.js";
import { uniqueRunFolder } from "../report/run-folder.js";
import { reportRoot as workspaceReportRoot } from "../studio/workspace.js";
import { writeReports } from "../report/index.js";
import { canonicalCommand, unavailableReason } from "./commands.js";
import { createScriptState, evalFlowExpression } from "./script-env.js";
import { desktopCommandNeedsPage, executeDesktopCommand } from "./desktop-commands.js";

const activeAppLocks = new Set<string>();

type ExecState = {
  driver: AutomationDriver | null;
  env: Record<string, string>;
  flowDir: string;
  screenshotDir: string;
  lastLocator?: LocatorMatch;
  script: ReturnType<typeof createScriptState>;
  colorScheme: "light" | "dark";
};

export type DriverSlot = { current: AutomationDriver | null };

export type RunnerOptions = RunOptions & {
  keepDriver?: boolean;
  driverSlot?: DriverSlot;
  onStep?: (event: {
    index: number;
    command: string;
    status: "running" | "passed" | "failed";
    durationMs?: number;
    error?: string;
  }) => void;
  /** Called after a step with the page that step left current, before the pace pause. */
  onPreview?: (driver: AutomationDriver) => Promise<void>;
};

export async function runFlowFile(
  flowPath: string,
  options: RunnerOptions = {},
  configAppPath?: string
): Promise<RunReport> {
  const flow = parseFlowFile(flowPath);
  const flowDir = dirname(resolve(flowPath));
  return runFlowDocument(flow, { ...options, cwd: options.cwd ?? flowDir }, configAppPath, flowPath);
}

export async function runFlowDocument(
  flow: FlowDocument,
  options: RunnerOptions = {},
  configAppPath?: string,
  flowPath?: string
): Promise<RunReport> {
  const runRetry = options.runRetry ?? 0;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= runRetry; attempt++) {
    try {
      return await runFlowOnce(flow, options, configAppPath, flowPath);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < runRetry) continue;
      throw lastError;
    }
  }
  throw lastError ?? new Error("Run failed");
}

async function runFlowOnce(
  flow: FlowDocument,
  options: RunnerOptions,
  configAppPath?: string,
  flowPath?: string
): Promise<RunReport> {
  const lockKey = flow.appPath || flow.appId;
  if (activeAppLocks.has(lockKey)) {
    throw new FlowError(
      `Another run is already using "${lockKey}". Only one instance is supported.`
    );
  }
  activeAppLocks.add(lockKey);

  const resultsRoot = resolve(options.reportDir ?? workspaceReportRoot());
  const runId = uniqueRunFolder(resultsRoot, flow.name ?? flow.appId);
  const reportDir = join(resultsRoot, runId);
  const screenshotDir = join(reportDir, "screenshots");
  await mkdir(screenshotDir, { recursive: true });

  const env: Record<string, string> = {
    ...(flow.env ?? {}),
    ...(options.env ?? {})
  };

  const driverKind = inferDriver(flow.appId, flow.driver);
  const config = loadConfigFromAncestors(options.cwd ?? process.cwd());
  const appPath = flow.appPath || configAppPath || resolveAppPath(config);
  let fixtureUrl = env.FIXTURE_URL ?? process.env.SOLIDFLOW_FIXTURE_URL;
  if (driverKind === "chromium" && !fixtureUrl && flow.appId === "fixture.demo") {
    fixtureUrl = fixturePageUrl();
  }

  const state: ExecState = {
    driver: options.driverSlot?.current ?? null,
    env,
    flowDir: options.cwd ?? process.cwd(),
    screenshotDir,
    script: createScriptState(),
    colorScheme: "light"
  };
  const paceMs = options.paceMs ?? 0;

  const steps: StepReport[] = [];
  const startedAt = new Date().toISOString();
  let status: RunReport["status"] = "passed";
  let runError: Error | undefined;
  let deviceInfo: RunReport["device"] = {
    platform: process.platform,
    hostname: "local",
    driver: driverKind,
    appPath
  };

  try {
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i]!;
      const stepRetry = options.stepRetry ?? 0;
      let stepReport: StepReport | null = null;
      for (let attempt = 0; attempt <= stepRetry; attempt++) {
        const t0 = Date.now();
        const command = formatStep(step);
        options.onStep?.({ index: i, command, status: "running" });
        try {
          await executeStep(step, state, flow, {
            appPath,
            driverKind,
            fixtureUrl,
            locale: flow.locale ?? "en",
            headless: options.headless,
            screenshotDir,
            flowPath,
            paceMs
          });
          if (state.driver) await options.onPreview?.(state.driver).catch(() => {});
          if (paceMs) await delay(paceMs);
          stepReport = {
            index: i,
            command,
            status: "passed",
            durationMs: Date.now() - t0,
            locator: state.lastLocator,
            screenshot: undefined
          };
          options.onStep?.({
            index: i,
            command,
            status: "passed",
            durationMs: Date.now() - t0
          });
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < stepRetry) {
            await delay(500);
            continue;
          }
          stepReport = {
            index: i,
            command: formatStep(step),
            status: "failed",
            durationMs: Date.now() - t0,
            error: msg,
            locator: state.lastLocator
          };
          try {
            if (state.driver) {
              stepReport.screenshot = await state.driver.takeScreenshot(`fail-step-${i}`);
            }
          } catch {
            // ignore screenshot errors on failure
          }
          if (state.driver) await options.onPreview?.(state.driver).catch(() => {});
          status = "failed";
          steps.push(stepReport);
          options.onStep?.({
            index: i,
            command,
            status: "failed",
            durationMs: Date.now() - t0,
            error: msg
          });
          runError = err instanceof Error ? err : new Error(String(err));
          break;
        }
      }
      if (stepReport && stepReport.status === "passed") steps.push(stepReport);
      if (runError) break;
    }
  } finally {
    if (state.driver) {
      deviceInfo = state.driver.getDeviceInfo();
    }
    if (options.driverSlot) {
      options.driverSlot.current = state.driver;
    }
    if (!options.keepDriver && state.driver) {
      await state.driver.disconnect().catch(() => {});
    }
    activeAppLocks.delete(lockKey);
  }

  const finishedAt = new Date().toISOString();
  const report: RunReport = {
    runId,
    flowName: flow.name ?? flow.appId,
    appId: flow.appId,
    driver: driverKind,
    startedAt,
    finishedAt,
    status,
    device: deviceInfo,
    steps,
    reportDir
  };

  await writeReports(report);
  if (runError) {
    throw runError;
  }
  return report;
}

type StepCtx = {
  appPath?: string;
  driverKind: import("../types.js").DriverKind;
  fixtureUrl?: string;
  locale: string;
  headless?: boolean;
  screenshotDir: string;
  flowPath?: string;
  paceMs: number;
};

async function executeStep(
  step: FlowStep,
  state: ExecState,
  flow: FlowDocument,
  ctx: StepCtx
): Promise<void> {
  try {
    await executeStepBody(step, state, flow, ctx);
  } catch (err) {
    if (stepIsOptional(step)) return;
    throw err;
  }
}

function popupTimeout(value: unknown): number {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : value && typeof value === "object" && !Array.isArray(value)
          ? Number((value as { timeout?: unknown }).timeout)
          : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0) return 10_000;
  return Math.min(raw, 120_000);
}

function stepIsOptional(step: FlowStep): boolean {
  if (typeof step !== "object" || step === null || Array.isArray(step)) return false;
  const key = Object.keys(step)[0];
  if (!key) return false;
  const value = step[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.optional === true;
}

async function executeStepBody(
  step: FlowStep,
  state: ExecState,
  flow: FlowDocument,
  ctx: StepCtx
): Promise<void> {
  const parsed = parseStep(step);
  const name = canonicalCommand(parsed.name);
  const blocked = unavailableReason(name);
  if (blocked) throw new FlowError(blocked);
  if (await shouldSkip(parsed, state, flow, ctx)) return;

  if (name === "launchApp") {
    if (parsed.kind === "complex" && isRecord(parsed.value) && parsed.value.clearState === true && state.driver) {
      await state.driver.clearState();
      await state.driver.disconnect();
      state.driver = null;
    }
    await ensureDriver(state, flow, ctx);
    if (state.driver) await focusAndAnnounce(state.driver, "launchApp", ctx.paceMs);
    return;
  }

  if (desktopCommandNeedsPage(name) || name === "killApp" || name === "evalScript" || name === "assertTrue" || name === "runScript") {
    if (desktopCommandNeedsPage(name) && !state.driver) await ensureDriver(state, flow, ctx);
    if (state.driver) await focusAndAnnounce(state.driver, name, ctx.paceMs);
    const page = state.driver?.getPage();
    if (desktopCommandNeedsPage(name) && !page) throw new FlowError(`${name} requires a connected app`);
    await executeDesktopCommand(name, parsed.kind === "simple" ? undefined : parsed.value, {
      page: page!,
      env: state.env,
      flowDir: state.flowDir,
      script: state.script,
      colorScheme: state.colorScheme,
      setColorScheme: scheme => {
        state.colorScheme = scheme;
      },
      driver: state.driver,
      clearDriver: () => {
        state.driver = null;
      },
      paceMs: ctx.paceMs
    });
    return;
  }

  if (name === "waitForPopup" || name === "switchToMain") {
    if (!state.driver) await ensureDriver(state, flow, ctx);
    const driver = state.driver!;
    if (name === "switchToMain") await driver.switchToMain();
    else await driver.waitForPopup(popupTimeout(parsed.kind === "simple" ? undefined : parsed.value));
    await focusAndAnnounce(driver, name, ctx.paceMs);
    return;
  }

  if (parsed.kind === "simple") {
    switch (name) {
      case "stopApp":
        if (ctx.paceMs) await delay(ctx.paceMs);
        if (state.driver) {
          await state.driver.disconnect();
          state.driver = null;
        }
        return;
      case "clearState":
        if (!state.driver) await ensureDriver(state, flow, ctx);
        await state.driver!.clearState();
        return;
      case "scroll":
        if (!state.driver) await ensureDriver(state, flow, ctx);
        await state.driver!.getPage().mouse.wheel(0, 400);
        return;
      case "eraseText":
        if (!state.driver) await ensureDriver(state, flow, ctx);
        await state.driver!.getPage().keyboard.press("Control+A");
        await state.driver!.getPage().keyboard.press("Backspace");
        return;
      default:
        throw new FlowError(`Unknown command: ${name}`);
    }
  }

  if (name === "runFlow") {
    const spec = parsed.kind === "kv" ? { file: String(parsed.value) } : asRecord(parsed.value);
    const commands = (spec.commands ?? spec.steps) as FlowStep[] | undefined;
    const previous = { ...state.env };
    if (isRecord(spec.env)) {
      for (const [key, item] of Object.entries(spec.env)) state.env[key] = String(item);
    }
    try {
      if (Array.isArray(commands)) {
        for (const inner of commands) await executeStep(inner, state, flow, ctx);
        return;
      }
      const file = String(spec.file ?? spec.path ?? "");
      if (!file) throw new FlowError("runFlow requires file or commands");
      const resolved = resolve(state.flowDir, interpolateEnv(file, state.env));
      const sub = parseFlowFile(resolved);
      for (const inner of sub.steps) await executeStep(inner, state, flow, ctx);
    } finally {
      state.env = previous;
    }
    return;
  }

  if (name === "repeat") {
    const spec = asRecord(parsed.value);
    const inner = (Array.isArray(spec.commands) ? spec.commands : spec.steps) as FlowStep[] | undefined;
    const steps = inner ?? [];
    if (isRecord(spec.while)) {
      const max = typeof spec.times === "number" ? spec.times : 20;
      for (let t = 0; t < max; t++) {
        if (!(await conditionMatches(spec.while, state, flow, ctx))) break;
        for (const innerStep of steps) await executeStep(innerStep, state, flow, ctx);
      }
      return;
    }
    const times = typeof spec.times === "number" ? spec.times : 1;
    for (let t = 0; t < times; t++) {
      for (const innerStep of steps) await executeStep(innerStep, state, flow, ctx);
    }
    return;
  }

  if (name === "if") {
    const spec = parsed.value as {
      visible?: string;
      steps?: FlowStep[];
      else?: FlowStep[];
    };
    if (!state.driver) await ensureDriver(state, flow, ctx);
    const page = state.driver!.getPage();
    let visible = false;
    if (spec.visible) {
      const q = interpolateEnv(spec.visible, state.env);
      try {
        const { locator } = await defaultLocatorResolver.resolve(page, q);
        visible = await locator.isVisible();
      } catch {
        visible = false;
      }
    }
    const branch = visible ? spec.steps ?? [] : spec.else ?? [];
    for (const s of branch) {
      await executeStep(s, state, flow, ctx);
    }
    return;
  }

  if (name === "retry") {
    const spec = asRecord(parsed.value);
    const times = typeof spec.maxRetries === "number" ? spec.maxRetries : typeof spec.times === "number" ? spec.times : 3;
    const inner = ((Array.isArray(spec.commands) ? spec.commands : spec.steps) ?? []) as FlowStep[];
    let lastErr: Error | undefined;
    for (let i = 0; i < times; i++) {
      try {
        for (const s of inner) {
          await executeStep(s, state, flow, ctx);
        }
        return;
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        await delay(300);
      }
    }
    throw lastErr ?? new Error("retry block failed");
  }

  if (name === "executeScript") {
    if (!state.driver) await ensureDriver(state, flow, ctx);
    await focusAndAnnounce(state.driver!, "executeScript", ctx.paceMs);
    const script = String(parsed.kind === "kv" ? parsed.value : "");
    await state.driver!.getPage().evaluate(`(0, eval)(${JSON.stringify(script)})`);
    return;
  }

  if (name === "executeShellCommand") {
    if (!shellAllowed()) {
      throw new FlowError("executeShellCommand requires SOLIDFLOW_ALLOW_SHELL=1");
    }
    const spec = parsed.value as { command?: string; args?: string[] };
    const args = spec.args ?? (spec.command ? spec.command.split(/\s+/) : []);
    if (!args.length) throw new FlowError("executeShellCommand requires args");
    const cwd = resolve(state.flowDir);
    await new Promise<void>((res, rej) => {
      const child = spawn(args[0]!, args.slice(1), { cwd, shell: false, stdio: "inherit" });
      child.on("error", rej);
      child.on("close", code => {
        if (code === 0) res();
        else rej(new Error(`Shell command exited with ${code}`));
      });
    });
    return;
  }

  if (!state.driver) await ensureDriver(state, flow, ctx);
  const driver = state.driver!;
  const page = driver.getPage();
  await focusAndAnnounce(driver, name, ctx.paceMs);

  const strVal = (v: unknown) => interpolateEnv(String(v), state.env);

  switch (name) {
    case "tapOn":
    case "doubleTapOn":
    case "longPressOn": {
      const raw = parsed.kind === "kv" ? parsed.value : parsed.value;
      let q: string;
      let force = false;
      let index: number | undefined;
      if (isRecord(raw) && typeof raw.point === "string") {
        const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
        const point = parsePoint(raw.point, viewport);
        if (!point) throw new FlowError(`Invalid point: ${raw.point}`);
        const clicks = name === "doubleTapOn" ? 2 : 1;
        await page.mouse.click(point.x, point.y, { clickCount: clicks, delay: name === "longPressOn" ? 800 : 0 });
        return;
      }
      if (isRecord(raw)) {
        q = strVal(raw.text ?? raw.id ?? "");
        force = raw.force === true;
        if (typeof raw.index === "number") index = raw.index;
      } else {
        q = strVal(raw);
      }
      const { locator, match } = await defaultLocatorResolver.resolve(page, q, index);
      state.lastLocator = match;
      await presentTarget(page, locator, ctx.paceMs);
      if (isRecord(raw) && typeof raw.enabled === "boolean" && (await locator.isEnabled()) !== raw.enabled) {
        throw new FlowError(`Element "${q}" did not match enabled: ${String(raw.enabled)}`);
      }
      const times = isRecord(raw) && typeof raw.repeat === "number" ? Math.max(1, raw.repeat) : 1;
      const gap = isRecord(raw) && typeof raw.delay === "number" ? raw.delay : 0;
      for (let n = 0; n < times; n++) {
        if (n > 0 && gap) await delay(gap);
        if (name === "tapOn") await locator.click({ force });
        else if (name === "doubleTapOn") await locator.dblclick({ force });
        else await locator.click({ delay: 800, force });
      }
      return;
    }
    case "inputText": {
      const raw = parsed.kind === "kv" ? parsed.value : parsed.value;
      const q = isRecord(raw) ? strVal(raw.text ?? "") : strVal(raw);
      const parts = q.split("|");
      const text = parts.length > 1 ? parts.slice(1).join("|") : q;
      const target = parts.length > 1 ? parts[0]! : undefined;
      if (target) {
        const { locator, match } = await defaultLocatorResolver.resolve(page, target);
        state.lastLocator = match;
        await presentTarget(page, locator, ctx.paceMs);
        if (ctx.paceMs) {
          await locator.click();
          await locator.fill("");
          await locator.pressSequentially(text, { delay: 70 });
        } else {
          await locator.fill(text);
        }
      } else {
        await page.keyboard.type(text, { delay: ctx.paceMs ? 70 : 0 });
      }
      return;
    }
    case "eraseText": {
      const raw = parsed.kind === "kv" ? parsed.value : parsed.value;
      if (typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw))) {
        const count = Number(raw);
        for (let n = 0; n < count; n++) await page.keyboard.press("Backspace");
        return;
      }
      if (raw == null || raw === "") {
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        return;
      }
      const q = strVal(raw);
      const { locator, match } = await defaultLocatorResolver.resolve(page, q);
      state.lastLocator = match;
      await presentTarget(page, locator, ctx.paceMs);
      await locator.fill("");
      return;
    }
    case "scroll": {
      const raw = parsed.kind === "kv" ? parsed.value : parsed.value;
      const dir = (isRecord(raw) ? strVal(raw.direction ?? "down") : strVal(raw ?? "down")).toLowerCase();
      const amount = dir === "left" || dir === "right" ? 400 : 400;
      if (dir === "left") await page.mouse.wheel(-amount, 0);
      else if (dir === "right") await page.mouse.wheel(amount, 0);
      else if (dir === "up") await page.mouse.wheel(0, -amount);
      else await page.mouse.wheel(0, amount);
      return;
    }
    case "swipe": {
      const spec = asRecord(parsed.value);
      const viewport = page.viewportSize() ?? { width: 800, height: 600 };
      const cx = viewport.width / 2;
      const cy = viewport.height / 2;
      const d = String(spec.direction ?? "left").toLowerCase();
      let x2 = cx;
      let y2 = cy;
      if (d === "left") x2 = cx - 200;
      if (d === "right") x2 = cx + 200;
      if (d === "up") y2 = cy - 200;
      if (d === "down") y2 = cy + 200;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(x2, y2, { steps: 10 });
      await page.mouse.up();
      return;
    }
    case "waitForVisible":
    case "assertVisible": {
      const raw = parsed.kind === "kv" ? parsed.value : parsed.value;
      const q = isRecord(raw) ? strVal(raw.text ?? raw.id ?? "") : strVal(raw);
      const { locator, match } = await defaultLocatorResolver.resolve(page, q);
      state.lastLocator = match;
      await locator.waitFor({ state: "visible", timeout: name === "waitForVisible" ? 30_000 : 10_000 });
      await presentTarget(page, locator, ctx.paceMs);
      return;
    }
    case "waitForHidden":
    case "assertNotVisible": {
      const raw = parsed.kind === "kv" ? parsed.value : parsed.value;
      const q = isRecord(raw) ? strVal(raw.text ?? raw.id ?? "") : strVal(raw);
      const { locator, match } = await defaultLocatorResolver.resolve(page, q);
      state.lastLocator = match;
      await locator.waitFor({ state: "hidden", timeout: 30_000 });
      return;
    }
    case "assertText": {
      let query: string;
      let expected: string;
      let mode: string | undefined;
      if (parsed.kind === "complex" && parsed.value && typeof parsed.value === "object") {
        const spec = parsed.value as { target?: string; text?: string; mode?: string };
        query = interpolateEnv(spec.target ?? "", state.env);
        expected = interpolateEnv(spec.text ?? "", state.env);
        mode = spec.mode;
      } else {
        const raw = strVal(parsed.kind === "kv" ? parsed.value : "");
        const parts = raw.split("|");
        query = parts[0] ?? "";
        expected = parts.slice(1).join("|");
      }
      const { locator, match } = await defaultLocatorResolver.resolve(page, query);
      state.lastLocator = match;
      await presentTarget(page, locator, ctx.paceMs);
      const text = (await locator.textContent()) ?? "";
      if (mode === "regex") {
        if (!new RegExp(expected).test(text)) {
          throw new FlowError(`assertText regex failed: expected ${expected}, got ${text}`);
        }
      } else if (mode === "partial") {
        if (!text.includes(expected)) {
          throw new FlowError(`assertText partial failed: expected substring ${expected}`);
        }
      } else if (text.trim() !== expected.trim()) {
        throw new FlowError(`assertText failed: expected "${expected}", got "${text}"`);
      }
      return;
    }
    case "takeScreenshot": {
      const label = strVal(parsed.kind === "kv" ? parsed.value : "screenshot");
      await driver.takeScreenshot(label);
      return;
    }
    case "assertScreenshot": {
      const spec = parsed.value as string | { name?: string; baseline?: string; threshold?: number };
      const name = typeof spec === "string" ? spec : spec.name ?? "baseline";
      const baselinePath =
        typeof spec === "object" && spec.baseline
          ? resolve(state.flowDir, spec.baseline)
          : join(state.flowDir, "baselines", `${name}.png`);
      const threshold = typeof spec === "object" ? spec.threshold ?? 0.1 : 0.1;
      const currentPath = await driver.takeScreenshot(`assert-${name}`);
      const diff = await comparePng(baselinePath, currentPath, join(state.screenshotDir, `diff-${name}.png`), threshold);
      if (!diff.pass) {
        throw new FlowError(`assertScreenshot: ${diff.percent.toFixed(2)}% pixels differ (max ${threshold * 100}%)`);
      }
      return;
    }
    default:
      throw new FlowError(`Unsupported command: ${name}`);
  }
}

async function focusAndAnnounce(
  driver: AutomationDriver,
  command: string,
  paceMs: number
): Promise<void> {
  const page = driver.getPage();
  await page.bringToFront().catch(() => {});
  if (!paceMs) return;
  const banner = `(() => {
    let bar = document.getElementById("__solidFlow_step");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "__solidFlow_step";
      bar.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#1c2330;color:#fff;padding:10px 14px;border-radius:8px;font:600 14px Segoe UI,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)";
      document.documentElement.appendChild(bar);
    }
    bar.textContent = ${JSON.stringify(command)};
  })()`;
  await page.evaluate(banner).catch(() => {});
}

async function presentTarget(
  page: import("playwright-core").Page,
  locator: import("playwright-core").Locator,
  paceMs: number
): Promise<void> {
  if (!paceMs) return;
  await page.bringToFront().catch(() => {});
  const box = await locator.boundingBox().catch(() => null);
  if (box) {
    const ring = `(() => {
      let ring = document.getElementById("__solidFlow_ring");
      if (!ring) {
        ring = document.createElement("div");
        ring.id = "__solidFlow_ring";
        ring.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:3px solid #e07a2f;border-radius:6px;box-shadow:0 0 0 6px rgba(224,122,47,.28)";
        document.documentElement.appendChild(ring);
      }
      ring.style.left = "${box.x}px";
      ring.style.top = "${box.y}px";
      ring.style.width = "${box.width}px";
      ring.style.height = "${box.height}px";
    })()`;
    await page.evaluate(ring).catch(() => {});
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 }).catch(() => {});
  }
  await delay(Math.max(400, Math.min(paceMs, 800)));
}

async function ensureDriver(state: ExecState, flow: FlowDocument, ctx: StepCtx): Promise<void> {
  if (state.driver) {
    if (ctx.paceMs) await state.driver.getPage().bringToFront().catch(() => {});
    return;
  }
  const driver = createDriver(ctx.driverKind);
  await driver.connect({
    appId: flow.appId,
    locale: ctx.locale,
    appPath: ctx.appPath,
    fixtureUrl: ctx.fixtureUrl,
    headless: ctx.headless,
    screenshotDir: ctx.screenshotDir
  });
  state.driver = driver;
}

function formatStep(step: FlowStep): string {
  if (typeof step === "string") return step;
  const k = Object.keys(step)[0];
  return k ? `${k}: ${JSON.stringify(step[k])}` : "{}";
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

async function shouldSkip(
  parsed: ReturnType<typeof parseStep>,
  state: ExecState,
  flow: FlowDocument,
  ctx: StepCtx
): Promise<boolean> {
  if (parsed.kind !== "complex" || !isRecord(parsed.value) || !isRecord(parsed.value.when)) return false;
  return !(await conditionMatches(parsed.value.when, state, flow, ctx));
}

async function conditionMatches(
  when: unknown,
  state: ExecState,
  flow: FlowDocument,
  ctx: StepCtx
): Promise<boolean> {
  const spec = asRecord(when);
  if (typeof spec.platform === "string") {
    const expected = spec.platform.toLowerCase();
    const actual = ctx.driverKind === "android" ? "android" : ctx.driverKind === "ios" ? "ios" : "web";
    if (expected !== actual) return false;
  }
  if (typeof spec.true === "boolean" && !spec.true) return false;
  if (typeof spec.true === "string" && !evalFlowExpression(state.script, spec.true, state.env)) return false;
  if (spec.visible != null) {
    if (!state.driver) await ensureDriver(state, flow, ctx);
    const query = typeof spec.visible === "string" ? spec.visible : "";
    if (!query) return false;
    try {
      const { locator } = await defaultLocatorResolver.resolve(
        state.driver!.getPage(),
        interpolateEnv(query, state.env)
      );
      if (!(await locator.isVisible())) return false;
    } catch {
      return false;
    }
  }
  if (spec.notVisible != null) {
    if (!state.driver) await ensureDriver(state, flow, ctx);
    const query = typeof spec.notVisible === "string" ? spec.notVisible : "";
    if (!query) return true;
    try {
      const { locator } = await defaultLocatorResolver.resolve(
        state.driver!.getPage(),
        interpolateEnv(query, state.env)
      );
      if (await locator.isVisible()) return false;
    } catch {
      return true;
    }
  }
  return true;
}

function parsePoint(point: string, viewport: { width: number; height: number }): { x: number; y: number } | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)(%)?\s*,\s*(-?\d+(?:\.\d+)?)(%)?\s*$/.exec(point);
  if (!match) return null;
  const x = match[2] ? (viewport.width * Number(match[1])) / 100 : Number(match[1]);
  const y = match[4] ? (viewport.height * Number(match[3])) / 100 : Number(match[3]);
  return { x, y };
}

async function comparePng(
  baselinePath: string,
  currentPath: string,
  diffPath: string,
  maxRatio: number
): Promise<{ pass: boolean; percent: number }> {
  const baseline = PNG.sync.read(await readFile(baselinePath));
  const current = PNG.sync.read(await readFile(currentPath));
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return { pass: false, percent: 100 };
  }
  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const numDiff = pixelmatch(baseline.data, current.data, diff.data, baseline.width, baseline.height, {
    threshold: 0.1
  });
  const percent = (numDiff / (baseline.width * baseline.height)) * 100;
  if (percent / 100 > maxRatio) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(diffPath, PNG.sync.write(diff));
  }
  return { pass: percent / 100 <= maxRatio, percent };
}
