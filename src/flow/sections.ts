import type {
  FlowSection,
  FlowStep,
  SectionReport,
  SectionStatus,
  StepReport,
  StepStatus
} from "../types.js";
import { FlowError } from "../types.js";

export const UNASSIGNED_SECTION = {
  number: 0,
  name: "Unassigned",
  description: "Commands not grouped into a section"
} as const;

type SectionSpec = {
  number?: unknown;
  name?: unknown;
  description?: unknown;
  steps?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSectionStep(step: FlowStep): boolean {
  return isRecord(step) && Object.keys(step).length === 1 && "section" in step;
}

function parseSectionSpec(raw: unknown, source: string, ordinal: number): {
  number: number;
  name: string;
  description: string;
  steps: FlowStep[];
} {
  if (!isRecord(raw)) {
    throw new FlowError(`${source}: section #${ordinal} must be an object`);
  }
  const spec = raw as SectionSpec;
  const number = Number(spec.number);
  if (!Number.isInteger(number) || number < 1) {
    throw new FlowError(`${source}: section #${ordinal} requires a unique positive number (1+)`);
  }
  const name = typeof spec.name === "string" ? spec.name.trim() : "";
  if (!name) {
    throw new FlowError(`${source}: section ${number} requires a non-empty name`);
  }
  const description = typeof spec.description === "string" ? spec.description : "";
  const steps =
    spec.steps == null
      ? []
      : Array.isArray(spec.steps)
        ? (spec.steps as FlowStep[])
        : null;
  if (steps === null) {
    throw new FlowError(`${source}: section ${number} ("${name}") requires a steps list`);
  }
  for (const inner of steps) {
    if (isSectionStep(inner as FlowStep)) {
      throw new FlowError(`${source}: nested sections are not supported (inside section ${number})`);
    }
  }
  return {
    number,
    name,
    description,
    steps
  };
}

/**
 * Flatten top-level `section` blocks into executable steps and build section metadata.
 * Commands outside any section land in the system Unassigned section (number 0).
 */
export function normalizeFlowSections(
  rawSteps: FlowStep[],
  source = "flow"
): { steps: FlowStep[]; sections: FlowSection[] } {
  const steps: FlowStep[] = [];
  const named: FlowSection[] = [];
  const unassignedIndices: number[] = [];
  const seenNumbers = new Set<number>();
  let sectionOrdinal = 0;

  for (const step of rawSteps) {
    if (!isSectionStep(step)) {
      unassignedIndices.push(steps.length);
      steps.push(step);
      continue;
    }

    sectionOrdinal += 1;
    const sectionValue = (step as Record<string, unknown>).section;
    const parsed = parseSectionSpec(sectionValue, source, sectionOrdinal);
    if (seenNumbers.has(parsed.number)) {
      throw new FlowError(`${source}: duplicate section number ${parsed.number}`);
    }
    seenNumbers.add(parsed.number);
    const stepIndices: number[] = [];
    for (const inner of parsed.steps) {
      stepIndices.push(steps.length);
      steps.push(inner);
    }
    named.push({
      number: parsed.number,
      name: parsed.name,
      description: parsed.description,
      stepIndices
    });
  }

  const sections = [...named].sort((a, b) => a.number - b.number);
  if (unassignedIndices.length > 0) {
    sections.push({
      number: UNASSIGNED_SECTION.number,
      name: UNASSIGNED_SECTION.name,
      description: UNASSIGNED_SECTION.description,
      stepIndices: unassignedIndices
    });
  }

  return { steps, sections };
}

export function sectionForIndex(sections: FlowSection[], index: number): FlowSection | undefined {
  return sections.find(section => section.stepIndices.includes(index));
}

export function sectionStatusFromSteps(
  sectionSteps: Array<{ status: StepStatus | "running" }>,
  totalSteps: number,
  runFinished: boolean
): SectionStatus {
  if (totalSteps === 0) return "passed";

  const hasRunning = sectionSteps.some(s => s.status === "running");
  const hasFailed = sectionSteps.some(s => s.status === "failed");
  const hasPassed = sectionSteps.some(s => s.status === "passed");
  const allReportedSkipped =
    sectionSteps.length === totalSteps && sectionSteps.every(s => s.status === "skipped");

  if (hasFailed) return "failed";
  if (hasRunning) return "running";
  if (allReportedSkipped) return "skipped";

  if (!runFinished) {
    // Only mark Running when this section has started and is not finished yet.
    if (sectionSteps.length === 0) return "pending";
    if (sectionSteps.length < totalSteps) return "running";
    if (sectionSteps.every(s => s.status === "passed")) return "passed";
  }

  if (sectionSteps.length === totalSteps && sectionSteps.every(s => s.status === "passed")) {
    return "passed";
  }

  if (sectionSteps.length > 0 && sectionSteps.every(s => s.status === "skipped")) {
    return "skipped";
  }

  // Run finished early (failure elsewhere): remaining steps in this section never ran.
  if (runFinished && !hasFailed) {
    if (sectionSteps.length === 0) return "skipped";
    if (hasPassed) return "passed";
  }

  return hasPassed ? "passed" : "skipped";
}

export function buildSectionReports(
  sections: FlowSection[],
  steps: StepReport[],
  options: { runFinished?: boolean; finishedAt?: string } = {}
): SectionReport[] {
  const runFinished = options.runFinished ?? true;
  const byIndex = new Map(steps.map(step => [step.index, step]));

  return [...sections]
    .sort((a, b) => a.number - b.number)
    .map(section => {
      const totalSteps = section.stepIndices.length;
      const sectionSteps = section.stepIndices
        .map(index => byIndex.get(index))
        .filter((step): step is StepReport => Boolean(step));
      const completedSteps = sectionSteps.filter(
        step => step.status === "passed" || step.status === "failed"
      ).length;
      const status = sectionStatusFromSteps(sectionSteps, totalSteps, runFinished);
      const failed = sectionSteps.find(step => step.status === "failed");
      return {
        number: section.number,
        name: section.name,
        description: section.description,
        status,
        completedSteps,
        totalSteps,
        steps: sectionSteps,
        failure: failed
          ? {
              command: failed.command,
              error: failed.error ?? "failed",
              timestamp: options.finishedAt ?? new Date().toISOString()
            }
          : undefined
      };
    });
}
