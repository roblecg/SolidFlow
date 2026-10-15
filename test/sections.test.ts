import { describe, expect, it } from "vitest";
import { parseFlowContent } from "../src/flow/parser.js";
import {
  buildSectionReports,
  normalizeFlowSections,
  sectionStatusFromSteps
} from "../src/flow/sections.js";
import type { StepReport } from "../src/types.js";

describe("flow sections", () => {
  it("flattens section steps and keeps metadata", () => {
    const { steps, sections } = normalizeFlowSections([
      {
        section: {
          number: 1,
          name: "Login Flow",
          description: "Login to tenant",
          steps: ["launchApp", { assertVisible: "Organization" }, { tapOn: "Continue" }]
        }
      },
      {
        section: {
          number: 2,
          name: "Home",
          description: "Land on home",
          steps: [{ assertVisible: "Home" }]
        }
      }
    ]);

    expect(steps).toEqual([
      "launchApp",
      { assertVisible: "Organization" },
      { tapOn: "Continue" },
      { assertVisible: "Home" }
    ]);
    expect(sections).toEqual([
      {
        number: 1,
        name: "Login Flow",
        description: "Login to tenant",
        stepIndices: [0, 1, 2]
      },
      {
        number: 2,
        name: "Home",
        description: "Land on home",
        stepIndices: [3]
      }
    ]);
  });

  it("puts ungrouped commands into Unassigned (0)", () => {
    const { steps, sections } = normalizeFlowSections([
      "launchApp",
      {
        section: {
          number: 1,
          name: "Login Flow",
          description: "Login to tenant",
          steps: [{ tapOn: "Continue" }]
        }
      },
      { stopApp: true }
    ]);

    expect(steps).toHaveLength(3);
    expect(sections.map(s => s.number)).toEqual([1, 0]);
    const unassigned = sections.find(s => s.number === 0)!;
    expect(unassigned.name).toBe("Unassigned");
    expect(unassigned.stepIndices).toEqual([0, 2]);
  });

  it("wraps a section-less flow as Unassigned", () => {
    const flow = parseFlowContent(
      "appId: demo.app\n---\n- launchApp\n- tapOn: Continue\n"
    );
    expect(flow.sections).toHaveLength(1);
    expect(flow.sections![0]).toMatchObject({
      number: 0,
      name: "Unassigned",
      stepIndices: [0, 1]
    });
  });

  it("rejects duplicate section numbers", () => {
    expect(() =>
      normalizeFlowSections([
        {
          section: { number: 1, name: "A", description: "", steps: ["launchApp"] }
        },
        {
          section: { number: 1, name: "B", description: "", steps: ["stopApp"] }
        }
      ])
    ).toThrow(/duplicate section number 1/);
  });

  it("rejects reserved section number 0", () => {
    expect(() =>
      normalizeFlowSections([
        {
          section: { number: 0, name: "Bad", description: "", steps: ["launchApp"] }
        }
      ])
    ).toThrow(/positive number/);
  });

  it("computes section status and progress", () => {
    expect(sectionStatusFromSteps([{ status: "passed" }, { status: "passed" }], 2, true)).toBe(
      "passed"
    );
    expect(sectionStatusFromSteps([{ status: "passed" }, { status: "failed" }], 2, true)).toBe(
      "failed"
    );
    expect(sectionStatusFromSteps([{ status: "skipped" }, { status: "skipped" }], 2, true)).toBe(
      "skipped"
    );
    expect(sectionStatusFromSteps([{ status: "running" }], 3, false)).toBe("running");
    expect(sectionStatusFromSteps([], 3, false)).toBe("pending");

    const sections = normalizeFlowSections([
      {
        section: {
          number: 1,
          name: "Login Flow",
          description: "Login to tenant",
          steps: ["launchApp", { tapOn: "Continue" }]
        }
      }
    ]).sections;

    const reports = buildSectionReports(sections, [
      {
        index: 0,
        command: "launchApp",
        status: "passed",
        durationMs: 10
      },
      {
        index: 1,
        command: 'tapOn: "Continue"',
        status: "failed",
        durationMs: 20,
        error: "Element not found"
      }
    ] satisfies StepReport[]);

    expect(reports[0]).toMatchObject({
      number: 1,
      status: "failed",
      completedSteps: 2,
      totalSteps: 2,
      failure: {
        command: 'tapOn: "Continue"',
        error: "Element not found"
      }
    });
  });
});
