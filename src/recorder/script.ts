/** Injected into the live app. Clicks and typing become SolidFlow steps. */
export const RECORDER_INIT_SCRIPT = `
(() => {
  if (window.__solidFlowRecorder && window.__solidFlowRecorder.installed) return;
  window.__solidFlowRecorder = { steps: [], paused: true, installed: true };
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
    if (!el || el.id === "__solidFlow_step" || el.id === "__solidFlow_ring") return "";
    const node = el.closest("[role='option'], button, a, input, select, textarea, label, [data-testid]") || el;
    const role = node.getAttribute("role") || "";
    const id = node.id || "";
    const testId = node.getAttribute("data-testid") || "";
    const name = node.getAttribute("aria-label") || "";
    const text = (node.innerText || node.textContent || "").trim().split("\\n")[0].slice(0, 80);
    const generatedId = !id || /^cl-/.test(id) || /-option-\\d+$/.test(id);
    if (role === "option" && text) return "role:option/" + text;
    if (testId) return testId;
    if (!generatedId) return id;
    if (name) return name;
    return text;
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
