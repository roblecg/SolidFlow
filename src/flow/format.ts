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

export type FlowFormatIssue = {
  line: number;
  kind: "missing" | "extra";
  amount: number;
  part: "indent" | "colon" | "colon-before" | "trailing" | "marker" | "list";
  text: string;
};

type Frame = { kind: "root" | "section" | "steps" | "block"; child: number };

/**
 * Reorganize section steps and normalize YAML layout for flow files.
 */
export function formatFlowContent(content: string): string {
  return formatFlowDocument(content).content;
}

/**
 * Format a flow and report lines whose spacing does not match the layout.
 * Indent issues are measured against the formatted document, so a line that
 * is short a few spaces or indented too far is called out with its line number.
 */
export function formatFlowDocument(content: string): { content: string; issues: FlowFormatIssue[] } {
  const repaired = repairFlowSpacing(content);
  const formatted = formatCanonical(repaired.content);
  const indent = diffIndent(content, formatted);
  const issues = [...repaired.issues, ...indent].sort((a, b) => a.line - b.line || a.part.localeCompare(b.part));
  return { content: formatted, issues };
}

export function describeFormatIssue(issue: FlowFormatIssue): string {
  const place =
    issue.part === "colon" ? " after ':'" :
    issue.part === "colon-before" ? " before ':'" :
    issue.part === "marker" ? " after '-'" :
    issue.part === "list" ? " in the list" :
    issue.part === "trailing" ? " at the end of the line" :
    "";
  const noun = issue.amount === 1 ? "space" : "spaces";
  const snippet = issue.text ? ` (${truncate(issue.text)})` : "";
  if (issue.kind === "missing") {
    const amount = issue.amount === 1 ? "a" : String(issue.amount);
    return `Line ${issue.line} lacks ${amount} ${noun}${place}${snippet}`;
  }
  const amount = issue.amount === 1 ? "an extra" : `${issue.amount} extra`;
  return `Line ${issue.line} has ${amount} ${noun}${place}${snippet}`;
}

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? clean.slice(0, 39) + "..." : clean;
}

function formatCanonical(content: string): string {
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

function repairFlowSpacing(content: string): { content: string; issues: FlowFormatIssue[] } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const hasSeparator = lines.some(line => line.trim() === "---");
  let inBody = !hasSeparator;
  let frames: Frame[] = [{ kind: "root", child: 0 }];
  const issues: FlowFormatIssue[] = [];
  const out: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const lineNo = index + 1;
    if (raw.trim() === "") {
      if (/[ \t]/.test(raw)) {
        issues.push(makeIssue(lineNo, "extra", raw.replace(/\t/g, "  ").length, "trailing", ""));
      }
      out.push("");
      continue;
    }

    const lead = splitLead(raw);
    const trimmedEnd = lead.rest.trimEnd();
    const trailing = lead.rest.length - trimmedEnd.length;
    if (trailing > 0) issues.push(makeIssue(lineNo, "extra", trailing, "trailing", trimmedEnd.trim()));
    const body = normalizeBody(trimmedEnd, lineNo, issues);

    if (body === "---") {
      inBody = true;
      frames = [{ kind: "root", child: 0 }];
      out.push("---");
      continue;
    }

    if (!inBody) {
      const chosen = closestFrame(lead.spaces, frames, "deeper");
      frames.length = chosen.index + 1;
      out.push(`${" ".repeat(chosen.expected)}${body}`);
      if (opensBlock(body)) frames.push({ kind: "block", child: chosen.expected + 2 });
      continue;
    }

    if (/^#\s*Section\b/i.test(body)) {
      out.push(body);
      continue;
    }

    if (body.startsWith("#")) {
      const chosen = closestFrame(lead.spaces, frames, "deeper");
      out.push(`${" ".repeat(chosen.expected)}${body}`);
      continue;
    }

    if (/^- section\s*:/.test(body)) {
      frames = [{ kind: "root", child: 0 }, { kind: "section", child: 4 }];
      out.push(body);
      continue;
    }

    const sectionKey = /^(number|name|description|steps)\s*:/.exec(body);
    const top = frames[frames.length - 1]!;
    if (sectionKey && frames.some(frame => frame.kind === "section") && top.kind !== "block") {
      while (frames.length && frames[frames.length - 1]!.kind !== "section") frames.pop();
      out.push(`    ${body}`);
      if (sectionKey[1] === "steps" && opensBlock(body)) frames.push({ kind: "steps", child: 6 });
      continue;
    }

    if (body.startsWith("- ")) {
      const expected = closestListIndent(lead.spaces, frames);
      const frameIndex = indexOfChild(frames, expected);
      frames.length = frameIndex + 1;
      out.push(`${" ".repeat(expected)}${body}`);
      if (opensBlock(body)) frames.push({ kind: "block", child: expected + 4 });
      continue;
    }

    const chosen = closestFrame(lead.spaces, frames, "deeper");
    frames.length = chosen.index + 1;
    out.push(`${" ".repeat(chosen.expected)}${body}`);
    if (opensBlock(body)) frames.push({ kind: "block", child: chosen.expected + 2 });
  }

  return { content: out.join("\n"), issues };
}

function splitLead(line: string): { spaces: number; rest: string } {
  let spaces = 0;
  let index = 0;
  while (index < line.length) {
    const ch = line[index];
    if (ch === " ") spaces += 1;
    else if (ch !== "\t") break;
    index += 1;
  }
  return { spaces, rest: line.slice(index) };
}

function normalizeBody(text: string, line: number, issues: FlowFormatIssue[]): string {
  let next = normalizeMarker(text, line, issues);
  next = normalizeColon(next, line, issues);
  next = normalizeList(next, line, issues);
  return next;
}

function normalizeMarker(text: string, line: number, issues: FlowFormatIssue[]): string {
  if (text === "---" || text.startsWith("---")) return text;
  const extra = /^-( {2,})([\s\S]*)$/.exec(text);
  if (extra) {
    issues.push(makeIssue(line, "extra", extra[1]!.length - 1, "marker", text));
    return `- ${extra[2] ?? ""}`;
  }
  const missing = /^-(\S[\s\S]*)$/.exec(text);
  if (!missing) return text;
  issues.push(makeIssue(line, "missing", 1, "marker", text));
  return `- ${missing[1]}`;
}

function normalizeColon(text: string, line: number, issues: FlowFormatIssue[]): string {
  if (text.startsWith("#")) return text;
  const colon = findKeyColon(text);
  if (colon < 0) return text;
  const rawKey = text.slice(0, colon);
  const key = rawKey.trimEnd();
  const before = rawKey.length - key.length;
  const after = text.slice(colon + 1);
  if (before > 0) issues.push(makeIssue(line, "extra", before, "colon-before", text));
  if (after.trim() === "") {
    if (after.length > 0) issues.push(makeIssue(line, "extra", after.length, "colon", text));
    return `${key}:`;
  }
  const value = after.trimStart();
  const gap = after.length - value.length;
  if (gap === 0) issues.push(makeIssue(line, "missing", 1, "colon", text));
  else if (gap > 1) issues.push(makeIssue(line, "extra", gap - 1, "colon", text));
  return `${key}: ${value}`;
}

function normalizeList(text: string, line: number, issues: FlowFormatIssue[]): string {
  const match = /^(.*:\s)\[([^\[\]"']*)\]$/.exec(text);
  if (!match) return text;
  const pieces = match[2]!.split(",");
  if (pieces.some(piece => piece.trim() === "")) return text;
  const rebuilt = pieces.map(piece => piece.trim()).join(", ");
  if (rebuilt === match[2]) return text;
  const oldSpaces = (match[2]!.match(/ /g) ?? []).length;
  const newSpaces = (rebuilt.match(/ /g) ?? []).length;
  if (newSpaces > oldSpaces) issues.push(makeIssue(line, "missing", newSpaces - oldSpaces, "list", text));
  else issues.push(makeIssue(line, "extra", Math.max(1, oldSpaces - newSpaces), "list", text));
  return `${match[1]}[${rebuilt}]`;
}

function findKeyColon(text: string): number {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (quote) {
      if (ch === quote && text[index - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":" && text[index + 1] !== "/" && text[index - 1] !== "/") return index;
  }
  return -1;
}

function opensBlock(text: string): boolean {
  if (text.startsWith("#")) return false;
  const body = text.replace(/^-\s+/, "");
  return /:\s*$/.test(body) || /:\s*[|>][+-]?\s*$/.test(body);
}

function closestFrame(actual: number, frames: Frame[], tie: "deeper" | "shallower"): { expected: number; index: number } {
  let best = 0;
  let bestDist = Math.abs(frames[0]!.child - actual);
  for (let index = 1; index < frames.length; index++) {
    const dist = Math.abs(frames[index]!.child - actual);
    const prefer = tie === "deeper" ? index > best : frames[index]!.child < frames[best]!.child;
    if (dist < bestDist || (dist === bestDist && prefer)) {
      best = index;
      bestDist = dist;
    }
  }
  return { expected: frames[best]!.child, index: best };
}

function closestListIndent(actual: number, frames: Frame[]): number {
  const candidates = frames
    .filter(frame => frame.kind === "root" || frame.kind === "steps" || frame.kind === "block")
    .map(frame => frame.child);
  const pool = candidates.length ? candidates : [0];
  let best = pool[0]!;
  let bestDist = Math.abs(actual - best);
  for (const candidate of pool.slice(1)) {
    const dist = Math.abs(actual - candidate);
    if (dist < bestDist || (dist === bestDist && candidate < best)) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

function indexOfChild(frames: Frame[], child: number): number {
  for (let index = frames.length - 1; index >= 0; index--) {
    if (frames[index]!.child === child) return index;
  }
  return 0;
}

function diffIndent(original: string, formatted: string): FlowFormatIssue[] {
  const left = original.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const right = formatted.split("\n");
  const issues: FlowFormatIssue[] = [];
  let cursor = 0;
  for (let index = 0; index < left.length; index++) {
    const raw = left[index] ?? "";
    if (raw.trim() === "") continue;
    while (cursor < right.length && (right[cursor] ?? "").trim() === "") cursor += 1;
    while (
      cursor < right.length &&
      (right[cursor] ?? "").trim() === "# Section" &&
      raw.trim() !== "# Section"
    ) {
      cursor += 1;
    }
    let match = cursor;
    const wanted = matchKey(raw);
    if (match >= right.length || matchKey(right[match] ?? "") !== wanted) {
      const found = right.slice(cursor, cursor + 6).findIndex(line => matchKey(line) === wanted);
      if (found < 0) continue;
      match = cursor + found;
    }
    const actual = splitLead(raw).spaces;
    const expected = splitLead(right[match] ?? "").spaces;
    if (actual !== expected) {
      issues.push(makeIssue(
        index + 1,
        actual < expected ? "missing" : "extra",
        Math.abs(expected - actual),
        "indent",
        raw.trim()
      ));
    }
    cursor = match + 1;
  }
  return issues;
}

function matchKey(line: string): string {
  return line
    .trim()
    .replace(/\s+/g, " ")
    .replace(/:\s*/g, ": ")
    .replace(/: $/, ":")
    .replace(/: "([^"]*)"/g, ": $1")
    .replace(/: '([^']*)'/g, ": $1");
}

function makeIssue(
  line: number,
  kind: FlowFormatIssue["kind"],
  amount: number,
  part: FlowFormatIssue["part"],
  text: string
): FlowFormatIssue {
  return { line, kind, amount, part, text: text.replace(/\s+/g, " ").trim().slice(0, 48) };
}
