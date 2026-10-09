import type { Locator, Page } from "playwright-core";
import type { LocatorMatch } from "../types.js";
import { FlowError } from "../types.js";
import type { AutomationDriver } from "../driver/types.js";
import { defaultLocatorResolver } from "../driver/locator.js";
import { interpolateEnv } from "../util/ids.js";
import { evalFlowExpression, runScriptFile, type FlowScriptState } from "./script-env.js";

export type DesktopTools = {
  page: Page;
  env: Record<string, string>;
  flowDir: string;
  script: FlowScriptState;
  colorScheme: "light" | "dark";
  setColorScheme: (scheme: "light" | "dark") => void;
  driver: AutomationDriver | null;
  clearDriver: () => void;
  paceMs: number;
};

const PAGE_COMMANDS = new Set([
  "scrollUntilVisible",
  "extendedWaitUntil",
  "copyTextFrom",
  "hideKeyboard",
  "openLink",
  "pasteText",
  "pressKey",
  "back",
  "waitForAnimationToEnd",
  "setDarkMode",
  "toggleDarkMode",
  "assertDarkMode",
  "assertLightMode",
  "setLocation",
  "setOrientation",
  "setPermissions"
]);

export function desktopCommandNeedsPage(name: string): boolean {
  return PAGE_COMMANDS.has(name) || name === "setClipboard";
}

export async function executeDesktopCommand(
  name: string,
  value: unknown,
  tools: DesktopTools
): Promise<void> {
  switch (name) {
    case "back":
      return goBack(tools.page);
    case "hideKeyboard":
      await tools.page.evaluate(
        "document.activeElement && document.activeElement.blur && document.activeElement.blur()"
      );
      return;
    case "pressKey":
      return pressKey(tools.page, readString(value, tools.env));
    case "openLink":
      return openLink(tools.page, readString(value, tools.env));
    case "copyTextFrom":
      return copyTextFrom(tools, value);
    case "pasteText":
      return pasteText(tools, value);
    case "setClipboard":
      tools.script.copiedText = readString(value, tools.env);
      await tools.page
        .evaluate(`navigator.clipboard && navigator.clipboard.writeText(${JSON.stringify(tools.script.copiedText)})`)
        .catch(() => undefined);
      return;
    case "scrollUntilVisible":
      return scrollUntilVisible(tools, value);
    case "extendedWaitUntil":
      return extendedWaitUntil(tools, value);
    case "waitForAnimationToEnd":
      return waitForAnimations(tools.page, record(value).timeout);
    case "evalScript":
      evalFlowExpression(tools.script, readString(value, tools.env), tools.env);
      return;
    case "assertTrue": {
      const source = readString(value, tools.env);
      const result = evalFlowExpression(tools.script, source, tools.env);
      if (!result) throw new FlowError(`assertTrue failed: ${source}`);
      return;
    }
    case "runScript":
      return runScript(tools, value);
    case "killApp":
      return killApp(tools, value);
    case "setDarkMode":
      return applyColorScheme(tools, readBool(value) ? "dark" : "light");
    case "toggleDarkMode":
      return applyColorScheme(tools, tools.colorScheme === "dark" ? "light" : "dark");
    case "assertDarkMode":
    case "assertLightMode":
      return assertColorScheme(tools.page, name === "assertDarkMode" ? "dark" : "light");
    case "setLocation":
      return setLocation(tools.page, value);
    case "setOrientation":
      return setOrientation(tools.page, readString(value, tools.env));
    case "setPermissions":
      return setPermissions(tools.page, value);
    default:
      throw new FlowError(`Unsupported command: ${name}`);
  }
}

async function goBack(page: Page): Promise<void> {
  const before = page.url();
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => undefined);
  if (page.url() === before) {
    await page.keyboard.press("Alt+ArrowLeft");
  }
}

async function pressKey(page: Page, key: string): Promise<void> {
  const normalized = key.trim().toLowerCase();
  if (normalized === "back") {
    await goBack(page);
    return;
  }
  const mapped: Record<string, string> = {
    enter: "Enter",
    tab: "Tab",
    escape: "Escape",
    esc: "Escape",
    backspace: "Backspace",
    delete: "Delete",
    space: " ",
    home: "Home",
    end: "End",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight"
  };
  if (normalized === "lock" || normalized === "volumeup" || normalized === "volumedown") {
    throw new FlowError(`pressKey "${key}" is a device key. Use Enter, Tab, Escape, arrows, Home, End, Backspace, or letters.`);
  }
  const press = mapped[normalized] ?? (key.length === 1 ? key : "");
  if (!press) throw new FlowError(`pressKey does not support "${key}" on the desktop driver.`);
  await page.keyboard.press(press);
}

async function openLink(page: Page, raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FlowError("openLink requires an http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FlowError("openLink only opens http and https URLs");
  }
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
}

async function copyTextFrom(tools: DesktopTools, value: unknown): Promise<void> {
  const { locator } = await resolveTarget(tools.page, value, tools.env);
  const text = ((await locator.textContent()) ?? "").trim();
  tools.script.copiedText = text;
}

async function pasteText(tools: DesktopTools, value: unknown): Promise<void> {
  if (!tools.script.copiedText) {
    throw new FlowError("pasteText: nothing to paste. Use copyTextFrom or setClipboard first.");
  }
  const selector = readSelector(value);
  if (selector) {
    const { locator } = await resolveTarget(tools.page, selector, tools.env);
    await locator.click();
  }
  await tools.page.keyboard.type(tools.script.copiedText, { delay: tools.paceMs ? 30 : 0 });
}

async function scrollUntilVisible(tools: DesktopTools, value: unknown): Promise<void> {
  const spec = record(value);
  const element = spec.element ?? value;
  if (element == null || element === "") throw new FlowError("scrollUntilVisible requires element");
  const direction = String(spec.direction ?? "DOWN").toUpperCase();
  const timeout = numberOr(spec.timeout, 20_000);
  const speed = Math.min(100, Math.max(0, numberOr(spec.speed, 40)));
  const visibility = numberOr(spec.visibilityPercentage, 100);
  const center = spec.centerElement === true;
  const started = Date.now();
  let extraCenters = 0;
  while (Date.now() - started < timeout) {
    const found = await tryResolve(tools.page, element, tools.env);
    if (found) {
      const percent = await visiblePercent(tools.page, found.locator);
      if (percent + 0.01 >= visibility) {
        if (!center || (await isCentered(tools.page, found.locator, direction)) || extraCenters >= 4) return;
        extraCenters += 1;
      }
    }
    await wheel(tools.page, direction, 120 + speed * 8);
    await delay(80);
  }
  throw new FlowError(`scrollUntilVisible timed out after ${timeout}ms`);
}

async function extendedWaitUntil(tools: DesktopTools, value: unknown): Promise<void> {
  const spec = record(value);
  const timeout = numberOr(spec.timeout, 10_000);
  const started = Date.now();
  if (spec.visible == null && spec.notVisible == null) {
    throw new FlowError("extendedWaitUntil requires visible or notVisible");
  }
  while (Date.now() - started < timeout) {
    if (spec.visible != null) {
      const found = await tryResolve(tools.page, spec.visible, tools.env);
      if (found && (await found.locator.isVisible().catch(() => false))) return;
    } else {
      const found = await tryResolve(tools.page, spec.notVisible, tools.env);
      if (!found || !(await found.locator.isVisible().catch(() => false))) return;
    }
    await delay(200);
  }
  throw new FlowError(`extendedWaitUntil timed out after ${timeout}ms`);
}

async function waitForAnimations(page: Page, timeoutValue: unknown): Promise<void> {
  const timeout = numberOr(timeoutValue, 5_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new FlowError(`waitForAnimationToEnd timed out after ${timeout}ms`)),
      timeout
    );
  });
  try {
    await Promise.race([
      page.evaluate(
        "Promise.all((document.getAnimations ? document.getAnimations() : []).map(animation => Promise.resolve(animation.finished).catch(() => {})))"
      ),
      timeoutPromise
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runScript(tools: DesktopTools, value: unknown): Promise<void> {
  const spec = record(value);
  const file = typeof value === "string" ? value : String(spec.file ?? "");
  if (!file) throw new FlowError("runScript requires file");
  const env = { ...tools.env };
  if (isRecord(spec.env)) {
    for (const [key, item] of Object.entries(spec.env)) env[key] = String(item);
  }
  await runScriptFile(tools.script, tools.flowDir, file, env);
}

async function killApp(tools: DesktopTools, value: unknown): Promise<void> {
  if (!tools.driver) return;
  if (record(value).clearState === true) await tools.driver.clearState();
  await tools.driver.disconnect();
  tools.clearDriver();
}

async function applyColorScheme(tools: DesktopTools, scheme: "light" | "dark"): Promise<void> {
  await tools.page.emulateMedia({ colorScheme: scheme });
  tools.setColorScheme(scheme);
}

async function assertColorScheme(page: Page, expected: "light" | "dark"): Promise<void> {
  const dark = Boolean(await page.evaluate("matchMedia('(prefers-color-scheme: dark)').matches"));
  const actual = dark ? "dark" : "light";
  if (actual !== expected) {
    throw new FlowError(`Expected ${expected} mode, but the page is ${actual}`);
  }
}

async function setLocation(page: Page, value: unknown): Promise<void> {
  const spec = record(value);
  const latitude = Number(spec.latitude);
  const longitude = Number(spec.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new FlowError("setLocation latitude must be between -90 and 90");
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new FlowError("setLocation longitude must be between -180 and 180");
  }
  await page.context().setGeolocation({ latitude, longitude });
  await page.context().grantPermissions(["geolocation"]).catch(() => undefined);
}

async function setOrientation(page: Page, value: string): Promise<void> {
  const orientation = value.trim().toUpperCase();
  const current = page.viewportSize() ?? { width: 1280, height: 720 };
  const wide = Math.max(current.width, current.height);
  const tall = Math.min(current.width, current.height);
  if (orientation.startsWith("LANDSCAPE")) {
    await page.setViewportSize({ width: wide, height: tall });
    return;
  }
  if (orientation.startsWith("PORTRAIT")) {
    await page.setViewportSize({ width: tall, height: wide });
    return;
  }
  throw new FlowError("setOrientation expects PORTRAIT or LANDSCAPE");
}

const PERMISSIONS: Record<string, Array<"geolocation" | "camera" | "microphone" | "notifications" | "clipboard-read" | "clipboard-write">> = {
  location: ["geolocation"],
  geolocation: ["geolocation"],
  camera: ["camera"],
  microphone: ["microphone"],
  notifications: ["notifications"],
  clipboard: ["clipboard-read", "clipboard-write"]
};

async function setPermissions(page: Page, value: unknown): Promise<void> {
  const spec = record(value);
  const permissions = isRecord(spec.permissions) ? spec.permissions : spec;
  const grant: Array<"geolocation" | "camera" | "microphone" | "notifications" | "clipboard-read" | "clipboard-write"> = [];
  for (const [key, setting] of Object.entries(permissions)) {
    if (key === "when" || key === "optional" || key === "label") continue;
    const mode = String(setting).toLowerCase();
    if (key === "all") {
      if (mode === "deny") await page.context().clearPermissions();
      continue;
    }
    const mapped = PERMISSIONS[key.toLowerCase()];
    if (!mapped) {
      throw new FlowError(
        `setPermissions does not support "${key}" on desktop. Use location, camera, microphone, notifications, or clipboard.`
      );
    }
    if (mode === "allow") grant.push(...mapped);
    else if (mode !== "deny" && mode !== "unset") {
      throw new FlowError(`setPermissions value for ${key} must be allow, deny, or unset`);
    }
  }
  if (grant.length) await page.context().grantPermissions(grant);
}

async function resolveTarget(
  page: Page,
  value: unknown,
  env: Record<string, string>
): Promise<{ locator: Locator; match: LocatorMatch }> {
  const spec = record(value);
  if (typeof spec.css === "string") {
    const css = interpolateEnv(spec.css, env);
    return {
      locator: page.locator(css).first(),
      match: { strategy: "text", value: css, confidence: 0.5 }
    };
  }
  const query = readSelector(value);
  if (!query) throw new FlowError("Command needs a selector");
  const resolved = await defaultLocatorResolver.resolve(page, interpolateEnv(query, env), numberOrUndefined(spec.index));
  if (typeof spec.enabled === "boolean" && (await resolved.locator.isEnabled()) !== spec.enabled) {
    throw new FlowError(`Element "${query}" did not match enabled: ${spec.enabled}`);
  }
  if (typeof spec.checked === "boolean" && (await resolved.locator.isChecked().catch(() => false)) !== spec.checked) {
    throw new FlowError(`Element "${query}" did not match checked: ${spec.checked}`);
  }
  return resolved;
}

async function tryResolve(
  page: Page,
  value: unknown,
  env: Record<string, string>
): Promise<{ locator: Locator; match: LocatorMatch } | null> {
  try {
    return await resolveTarget(page, value, env);
  } catch {
    return null;
  }
}

async function visiblePercent(page: Page, locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) return 0;
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const width = Math.max(0, Math.min(viewport.width, box.x + box.width) - Math.max(0, box.x));
  const height = Math.max(0, Math.min(viewport.height, box.y + box.height) - Math.max(0, box.y));
  return (width * height * 100) / (box.width * box.height);
}

async function isCentered(page: Page, locator: Locator, direction: string): Promise<boolean> {
  const box = await locator.boundingBox();
  if (!box) return false;
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  if (direction === "LEFT" || direction === "RIGHT") {
    return centerX > viewport.width * 0.3 && centerX < viewport.width * 0.7;
  }
  return centerY > viewport.height * 0.3 && centerY < viewport.height * 0.7;
}

async function wheel(page: Page, direction: string, amount: number): Promise<void> {
  if (direction === "UP") await page.mouse.wheel(0, -amount);
  else if (direction === "LEFT") await page.mouse.wheel(-amount, 0);
  else if (direction === "RIGHT") await page.mouse.wheel(amount, 0);
  else await page.mouse.wheel(0, amount);
}

function readSelector(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!isRecord(value)) return null;
  if (typeof value.text === "string") return value.text;
  if (typeof value.id === "string") return value.id;
  if (typeof value.element === "string" || typeof value.element === "number") return String(value.element);
  if (isRecord(value.element)) return readSelector(value.element);
  if (typeof value.visible === "string") return value.visible;
  if (typeof value.notVisible === "string") return value.notVisible;
  return null;
}

function readString(value: unknown, env: Record<string, string>): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return interpolateEnv(String(value), env);
  }
  const spec = record(value);
  if (typeof spec.text === "string") return interpolateEnv(spec.text, env);
  if (typeof spec.file === "string") return spec.file;
  return "";
}

function readBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() !== "false";
  return record(value).enabled !== false && value !== false;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}
