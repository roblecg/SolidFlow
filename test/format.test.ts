import { describe, expect, it } from "vitest";
import { describeFormatIssue, formatFlowContent, formatFlowDocument, reorganizeFlowSteps } from "../src/flow/format.js";

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

  it("repairs missing and extra spaces and names the lines", () => {
    const input = `appId: demo
name: Spacing
---
- section:
  number:1
   name:  Too much
    description:File launch
    steps:
    - launchApp
        - tapOn: Continue
`;
    const formatted = formatFlowDocument(input);
    expect(formatted.content).toContain("    number: 1");
    expect(formatted.content).toContain("    name: Too much");
    expect(formatted.content).toContain("    description: File launch");
    expect(formatted.content).toContain("      - launchApp");
    expect(formatted.content).toContain("      - tapOn: Continue");
    const messages = formatted.issues.map(describeFormatIssue);
    expect(messages).toContain("Line 5 lacks 2 spaces (number:1)");
    expect(messages).toContain("Line 5 lacks a space after ':' (number:1)");
    expect(messages).toContain("Line 6 lacks a space (name: Too much)");
    expect(messages).toContain("Line 6 has an extra space after ':' (name: Too much)");
    expect(messages).toContain("Line 7 lacks a space after ':' (description:File launch)");
    expect(messages).toContain("Line 9 lacks 2 spaces (- launchApp)");
    expect(messages).toContain("Line 10 has 2 extra spaces (- tapOn: Continue)");
  });

  it("keeps nested step keys and fixes an off-by-one indent", () => {
    const input = `appId: demo
name: Nested
---
- section:
    steps:
      - runFlow:
          env:
           KEY: value
          file: foo.yaml
`;
    const formatted = formatFlowDocument(input);
    expect(formatted.content).toContain("            KEY: value");
    expect(formatted.content).toContain("          file: foo.yaml");
    expect(formatted.issues.map(describeFormatIssue)).toContain("Line 8 lacks a space (KEY: value)");
  });

  it("is stable once spacing is already correct", () => {
    const input = `appId: demo
name: Clean
---
# Section
- section:
    number: 1
    name: One
    description: First
    steps:
      - launchApp
`;
    const once = formatFlowDocument(input);
    const twice = formatFlowDocument(once.content);
    expect(once.issues).toEqual([]);
    expect(twice.content).toBe(once.content);
    expect(twice.issues).toEqual([]);
  });
});
