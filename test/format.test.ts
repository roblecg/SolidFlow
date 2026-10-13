import { describe, expect, it } from "vitest";
import { formatFlowContent, reorganizeFlowSteps } from "../src/flow/format.js";

describe("formatFlowContent", () => {
  it("nests orphan commands under the preceding section", () => {
    const input = `appId: cimdocumentexporter
name: CIM login validation
---
- section:
    number: 1
    name: Section name
    description: What this section covers
    steps:
      - tapOn: Selector
- launchApp
- assertVisible: "Organization"
- tapOn: Continue
`;

    const formatted = formatFlowContent(input);
    expect(formatted).toContain("# Section\n- section:");
    expect(formatted).toContain("- launchApp");
    expect(formatted).toContain("- assertVisible: Organization");
    expect(formatted.indexOf("- launchApp")).toBeGreaterThan(formatted.indexOf("steps:"));
    expect(formatted.indexOf("- tapOn: Continue")).toBeGreaterThan(formatted.indexOf("- launchApp"));
    expect(formatted).not.toMatch(/\n- launchApp\n\s+- section:/);
  });

  it("starts a new section when the next section block appears", () => {
    const reorganized = reorganizeFlowSteps([
      {
        section: {
          number: 1,
          name: "One",
          description: "First",
          steps: [{ tapOn: "a" }]
        }
      },
      { launchApp: true },
      {
        section: {
          number: 2,
          name: "Two",
          description: "Second",
          steps: [{ tapOn: "b" }]
        }
      },
      { stopApp: true }
    ]);

    expect(reorganized).toEqual([
      {
        section: {
          number: 1,
          name: "One",
          description: "First",
          steps: [{ tapOn: "a" }, { launchApp: true }]
        }
      },
      {
        section: {
          number: 2,
          name: "Two",
          description: "Second",
          steps: [{ tapOn: "b" }, { stopApp: true }]
        }
      }
    ]);
  });

  it("leaves commands before the first section at the top level", () => {
    const reorganized = reorganizeFlowSteps([
      "launchApp",
      {
        section: {
          number: 1,
          name: "Login",
          description: "",
          steps: [{ tapOn: "Continue" }]
        }
      }
    ]);

    expect(reorganized[0]).toBe("launchApp");
  });

  it("strips standalone Section marker list items", () => {
    const reorganized = reorganizeFlowSteps([
      "Section",
      {
        section: { number: 1, name: "A", description: "", steps: [] }
      },
      "launchApp"
    ]);

    expect(reorganized).toEqual([
      {
        section: {
          number: 1,
          name: "A",
          description: "",
          steps: ["launchApp"]
        }
      }
    ]);
  });
});
