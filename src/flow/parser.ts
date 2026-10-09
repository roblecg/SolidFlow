import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type { FlowDocument, FlowStep } from "../types.js";
import { FlowError } from "../types.js";

type RawFlow = {
  appId?: string;
  appPath?: string;
  name?: string;
  tags?: string[];
  locale?: string;
  env?: Record<string, string>;
  driver?: FlowDocument["driver"];
  steps?: FlowStep[];
};

export function parseFlowFile(path: string): FlowDocument {
  const content = readFileSync(path, "utf8");
  return parseFlowContent(content, path);
}

export function parseFlowContent(content: string, source = "flow"): FlowDocument {
  const parts = content.split(/^---\s*$/m);
  let meta: RawFlow;
  let steps: FlowStep[];

  if (parts.length >= 2) {
    meta = (parseYaml(parts[0] ?? "") as RawFlow | null) ?? {};
    const stepDoc = parseYaml(parts.slice(1).join("\n---\n"));
    if (!Array.isArray(stepDoc)) {
      throw new FlowError(`${source}: steps after --- must be a YAML list`);
    }
    steps = stepDoc as FlowStep[];
  } else {
    const doc = parseYaml(content) as RawFlow & { steps?: FlowStep[] };
    if (!doc || typeof doc !== "object") {
      throw new FlowError(`${source}: invalid flow document`);
    }
    meta = doc;
    if (!Array.isArray(doc.steps)) {
      throw new FlowError(`${source}: flow must include steps or --- separator`);
    }
    steps = doc.steps;
  }

  const appPath = meta.appPath?.trim() || undefined;
  const appId = meta.appId?.trim() || (appPath ? basename(appPath) : "");
  if (!appId) {
    throw new FlowError(`${source}: appPath or appId is required`);
  }

  return {
    appId,
    appPath,
    name: meta.name,
    tags: meta.tags,
    locale: meta.locale ?? "en",
    env: meta.env,
    driver: meta.driver,
    steps
  };
}
