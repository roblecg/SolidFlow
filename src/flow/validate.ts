import type { FlowDocument } from "../types.js";

const ALLOWED_DRIVERS = new Set(["webview2", "chromium", "android", "ios", "browser"]);

export function validateFlowMeta(flow: FlowDocument): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!flow.appId?.trim() && !flow.appPath?.trim()) {
    errors.push("appPath or appId is required");
  }
  if (flow.driver && !ALLOWED_DRIVERS.has(flow.driver)) {
    errors.push(`/driver must be one of ${[...ALLOWED_DRIVERS].join(", ")}`);
  }
  if (flow.tags && !Array.isArray(flow.tags)) {
    errors.push("/tags must be an array");
  }
  return { valid: errors.length === 0, errors };
}

export function matchesTags(flow: FlowDocument, filterTags?: string[]): boolean {
  if (!filterTags?.length) return true;
  const flowTags = new Set(flow.tags ?? []);
  return filterTags.every(t => flowTags.has(t));
}

export function matchesName(flow: FlowDocument, nameFilter?: string): boolean {
  if (!nameFilter) return true;
  const name = flow.name ?? flow.appId;
  return name.toLowerCase().includes(nameFilter.toLowerCase());
}
