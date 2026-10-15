import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Minimal static page to reorder/delete recorded steps before saving YAML. */
export async function writeRecorderEditor(
  outDir: string,
  stepsJson: string,
  yamlPreview: string
): Promise<string> {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>SolidFlow Recorder Editor</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1.5rem; max-width: 960px; }
    textarea { width: 100%; min-height: 320px; font-family: ui-monospace, monospace; }
    ul { list-style: none; padding: 0; }
    li { display: flex; gap: 0.5rem; align-items: center; margin: 0.35rem 0; }
    button { cursor: pointer; }
  </style>
</head>
<body>
  <h1>Recorded steps</h1>
  <p>Delete rows, then copy YAML from the preview below.</p>
  <ul id="steps"></ul>
  <h2>YAML preview</h2>
  <textarea id="yaml" readonly></textarea>
  <script>
    const initial = ${stepsJson};
    const appHeader = ${JSON.stringify(yamlPreview.split("\\n")[0] ?? "appId: recorded")};
    const list = document.getElementById("steps");
    const yaml = document.getElementById("yaml");
    let steps = initial.slice();
    function render() {
      list.innerHTML = "";
      steps.forEach((step, i) => {
        const li = document.createElement("li");
        const label = document.createElement("span");
        const k = Object.keys(step)[0];
        label.textContent = "- " + k + ": " + step[k];
        const del = document.createElement("button");
        del.textContent = "Delete";
        del.onclick = () => { steps.splice(i, 1); render(); };
        li.append(del, label);
        list.append(li);
      });
      const lines = steps.map(s => {
        const k = Object.keys(s)[0];
        return "- " + k + ": " + s[k];
      });
      yaml.value = appHeader + "\\n---\\n" + lines.join("\\n") + "\\n";
    }
    render();
  </script>
</body>
</html>`;
  const path = join(outDir, "recorder-editor.html");
  await writeFile(path, html, "utf8");
  return path;
}
