import { DOM_TARGET_SOURCE } from "../inspector/dom-target.js";

/** Injected into the live app. Clicks and typing become SolidFlow steps. */
export const RECORDER_INIT_SCRIPT = `
(() => {
  if (window.__solidFlowRecorder && window.__solidFlowRecorder.installed) return;
  window.__solidFlowRecorder = { steps: [], paused: true, installed: true };
${DOM_TARGET_SOURCE}
  const push = (command, selector) => {
    const rec = window.__solidFlowRecorder;
    if (!rec || rec.paused || !selector) return;
    const now = Date.now();
    const last = rec.steps[rec.steps.length - 1];
    if (last && last[command] === selector && now - (rec.lastAt || 0) < 400) return;
    rec.lastAt = now;
    const step = {};
    step[command] = selector;
    rec.steps.push(step);
  };
  const describe = (el) => {
    const resolved = solidFlowResolve(el);
    return resolved && resolved.selector ? resolved.selector : "";
  };
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    push("tapOn", describe(target));
  }, true);
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    const key = describe(target);
    if (key) push("inputText", key + "|" + target.value);
  }, true);
})();
`;

export type RecordedStep = Record<string, string>;

export function formatRecordedStep(step: RecordedStep): string {
  const command = Object.keys(step)[0] ?? "";
  const selector = step[command] ?? "";
  const needsQuotes = /[:#\n"']|\s/.test(selector);
  const value = needsQuotes ? JSON.stringify(selector) : selector;
  return `- ${command}: ${value}`;
}

export function stepsToYaml(steps: RecordedStep[], appId: string): string {
  const lines = steps.map(step => formatRecordedStep(step));
  return `appId: ${appId}\n---\n${lines.join("\n")}\n`;
}
