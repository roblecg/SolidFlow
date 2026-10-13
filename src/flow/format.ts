import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isSectionStep } from "./sections.js";
import type { FlowStep } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSectionListItem(item: unknown): item is { section: Record<string, unknown> } {
  return isRecord(item) && Object.keys(item).length === 1 && "section" in item;
}

function isSectionMarkerItem(item: unknown): boolean {
  return typeof item === "string" && /^section$/i.test(item.trim());
}

/**
 * Move top-level commands that follow a `- section:` block into that section's `steps`
 * until the next section (or end of file).
 */
export function reorganizeFlowSteps(rawSteps: unknown[]): unknown[] {
  if (!Array.isArray(rawSteps)) return rawSteps;

  const output: unknown[] = [];
  let i = 0;

  while (i < rawSteps.length) {
    const item = rawSteps[i]!;

    if (isSectionMarkerItem(item)) {
      i += 1;
      continue;
    }

    if (!isSectionListItem(item)) {
      output.push(item);
      i += 1;
      continue;
    }

    const spec = { ...item.section };
    const steps: unknown[] = Array.isArray(spec.steps) ? [...spec.steps] : [];
    i += 1;

    while (i < rawSteps.length) {
      const next = rawSteps[i]!;
      if (isSectionMarkerItem(next)) {
        i += 1;
        continue;
      }
      if (isSectionListItem(next)) break;
      steps.push(next);
      i += 1;
    }

    for (const step of steps) {
      if (isSectionStep(step as FlowStep)) {
        throw new Error("Nested sections are not supported inside section steps");
      }
    }

    output.push({
      section: {
        ...spec,
        steps
      }
    });
  }

  return output;
}

function stringifySteps(steps: unknown[]): string {
  const yaml = stringifyYaml(steps, { lineWidth: 0, indent: 2 }).trimEnd();
  const lines: string[] = [];
  for (const line of yaml.split("\n")) {
    if (line.startsWith("- section:")) {
      lines.push("# Section", line);
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

function stripBareSectionLabels(yamlBody: string): string {
  return yamlBody.replace(/^\s*Section\s*$/gim, "");
}

/**
 * Reorganize section steps and normalize YAML layout for flow files.
 */
export function formatFlowContent(content: string): string {
  const parts = content.split(/^---\s*$/m);

  if (parts.length >= 2) {
    const meta = (parts[0] ?? "").replace(/\r\n/g, "\n").trimEnd();
    const body = stripBareSectionLabels(parts.slice(1).join("\n---\n"));
    const stepDoc = parseYaml(body);
    if (!Array.isArray(stepDoc)) {
      return content;
    }
    const reorganized = reorganizeFlowSteps(stepDoc);
    const stepsYaml = stringifySteps(reorganized);
    return meta ? `${meta}\n---\n${stepsYaml}\n` : `---\n${stepsYaml}\n`;
  }

  const doc = parseYaml(content) as { steps?: unknown[] } | null;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.steps)) {
    return content;
  }

  const { steps: _steps, ...meta } = doc as Record<string, unknown> & { steps: unknown[] };
  const reorganized = reorganizeFlowSteps(doc.steps);
  const metaYaml = stringifyYaml(meta, { lineWidth: 0, indent: 2 }).trimEnd();
  const stepsYaml = stringifySteps(reorganized);
  return `${metaYaml}\n---\n${stepsYaml}\n`;
}
