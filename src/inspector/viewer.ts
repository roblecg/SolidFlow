import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HierarchyNode } from "./hierarchy.js";

function renderNode(node: HierarchyNode, depth = 0): string {
  const pad = "  ".repeat(depth);
  const attrs = [
    node.id ? `#${node.id}` : "",
    node.testId ? `[data-testid=${node.testId}]` : "",
    node.role ? `role=${node.role}` : "",
    node.name ? `"${node.name}"` : "",
    node.text ? `text="${node.text.slice(0, 40)}"` : ""
  ]
    .filter(Boolean)
    .join(" ");
  const line = `${pad}<${node.tag}${attrs ? " " + attrs : ""}>\n`;
  return line + node.children.map(c => renderNode(c, depth + 1)).join("");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function writeInspectorPage(
  outDir: string,
  hierarchy: HierarchyNode,
  screenshotPath?: string
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const treeText = renderNode(hierarchy);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>SolidFlow Inspector</title>
  <style>
    body { font-family: ui-monospace, monospace; margin: 1rem; background: #111; color: #ddd; display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    pre { white-space: pre-wrap; font-size: 12px; max-height: 90vh; overflow: auto; background: #1a1a1a; padding: 1rem; border-radius: 8px; }
    img { max-width: 100%; border: 1px solid #333; border-radius: 8px; }
    h1 { grid-column: 1 / -1; font-family: system-ui, sans-serif; font-size: 1.2rem; }
  </style>
</head>
<body>
  <h1>SolidFlow Inspector</h1>
  <div>
    <h2>Hierarchy</h2>
    <pre>${esc(treeText)}</pre>
  </div>
  <div>
    <h2>Screenshot</h2>
    ${screenshotPath ? `<img src="${esc(screenshotPath)}" alt="screenshot"/>` : "<p>No screenshot</p>"}
  </div>
</body>
</html>`;
  const path = join(outDir, "inspector.html");
  await writeFile(path, html, "utf8");
  await writeFile(join(outDir, "hierarchy.json"), JSON.stringify(hierarchy, null, 2), "utf8");
  return path;
}
