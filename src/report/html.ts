import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "../types.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function writeHtmlReport(report: RunReport): Promise<string> {
  const path = join(report.reportDir, "report.html");
  const rows = report.steps
    .map(
      s => `<tr class="${s.status}">
  <td>${s.index + 1}</td>
  <td><code>${esc(s.command)}</code></td>
  <td>${s.status}</td>
  <td>${s.durationMs} ms</td>
  <td>${s.locator ? esc(`${s.locator.strategy} (${s.locator.confidence})`) : ""}</td>
  <td>${s.error ? esc(s.error) : ""}</td>
  <td>${s.screenshot ? `<a href="${esc(s.screenshot.replace(report.reportDir + "/", "").replace(/\\/g, "/"))}">shot</a>` : ""}</td>
</tr>`
    )
    .join("\n");

  const sectionRows = (report.sections ?? [])
    .map(
      section => `<tr class="${section.status}">
  <td>${section.number}</td>
  <td>${esc(section.name)}</td>
  <td>${esc(section.description)}</td>
  <td>${esc(section.status)} (${section.completedSteps}/${section.totalSteps})</td>
</tr>`
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>SolidFlow — ${esc(report.flowName)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #0f1419; color: #e7ecf3; }
    h1 { font-size: 1.4rem; }
    .summary { display: flex; gap: 1.5rem; margin: 1rem 0; flex-wrap: wrap; }
    .badge { padding: 0.25rem 0.6rem; border-radius: 4px; font-weight: 600; }
    .passed { background: #1a3d2e; color: #6ee7a0; }
    .failed { background: #4a1c1c; color: #fca5a5; }
    .skipped { background: #2a3544; color: #9ca3af; }
    .running { background: #1a2a44; color: #93c5fd; }
    .stopped { background: #3d2a12; color: #fbbf24; }
    .tabs { display: flex; gap: 0.5rem; margin: 1.25rem 0 0.75rem; border-bottom: 1px solid #2a3544; padding-bottom: 0.5rem; }
    .tab {
      border: 1px solid #2a3544;
      background: #1a2332;
      color: #c5ced9;
      border-radius: 6px;
      padding: 0.4rem 0.9rem;
      cursor: pointer;
      font: inherit;
    }
    .tab:hover { color: #e7ecf3; border-color: #3d4d63; }
    .tab.active { background: #243044; color: #fff; border-color: #4b6280; font-weight: 650; }
    .panel { display: none; }
    .panel.active { display: block; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    th, td { border: 1px solid #2a3544; padding: 0.5rem; text-align: left; vertical-align: top; }
    th { background: #1a2332; }
    tr.failed td { background: #2a1515; }
    code { font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>${esc(report.flowName)}</h1>
  <div class="summary">
    <span class="badge ${report.status}">${report.status.toUpperCase()}</span>
    <span>Run ${esc(report.runId)}</span>
    <span>Driver: ${esc(report.driver)}</span>
    <span>App: ${esc(report.appId)}</span>
  </div>
  <p><strong>Device:</strong> ${esc(report.device.platform)} @ ${esc(report.device.hostname)}</p>
  <p><strong>Started:</strong> ${esc(report.startedAt)} — <strong>Finished:</strong> ${esc(report.finishedAt)}</p>
  <div class="tabs" role="tablist" aria-label="Report views">
    <button type="button" class="tab active" role="tab" aria-selected="true" data-tab="sections">Test Cases (Sections)</button>
    <button type="button" class="tab" role="tab" aria-selected="false" data-tab="steps">Raw Steps</button>
  </div>
  <div id="panel-sections" class="panel active" role="tabpanel">
    <table>
      <thead><tr><th>Number</th><th>Name</th><th>Description</th><th>Status</th></tr></thead>
      <tbody>${sectionRows || `<tr><td colspan="4">No sections</td></tr>`}</tbody>
    </table>
  </div>
  <div id="panel-steps" class="panel" role="tabpanel" hidden>
    <table>
      <thead><tr><th>#</th><th>Command</th><th>Status</th><th>Duration</th><th>Locator</th><th>Error</th><th>Screenshot</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <script>
    (function () {
      var tabs = document.querySelectorAll(".tab");
      var panels = {
        sections: document.getElementById("panel-sections"),
        steps: document.getElementById("panel-steps")
      };
      tabs.forEach(function (tab) {
        tab.addEventListener("click", function () {
          var name = tab.getAttribute("data-tab");
          tabs.forEach(function (other) {
            var on = other === tab;
            other.classList.toggle("active", on);
            other.setAttribute("aria-selected", on ? "true" : "false");
          });
          Object.keys(panels).forEach(function (key) {
            var panel = panels[key];
            var on = key === name;
            panel.classList.toggle("active", on);
            if (on) panel.removeAttribute("hidden");
            else panel.setAttribute("hidden", "");
          });
        });
      });
    })();
  </script>
</body>
</html>`;
  await writeFile(path, html, "utf8");
  return path;
}
