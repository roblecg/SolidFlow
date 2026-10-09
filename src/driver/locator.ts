import type { Page, Locator } from "playwright-core";
import type { LocatorMatch } from "../types.js";
import type { LocatorResolver, LocatorQuery } from "./types.js";

const STRATEGIES: Array<{
  strategy: LocatorMatch["strategy"];
  confidence: number;
  build: (page: Page, query: string) => Locator;
}> = [
  {
    strategy: "testId",
    confidence: 1,
    build: (page, q) => page.getByTestId(q)
  },
  {
    strategy: "id",
    confidence: 0.95,
    build: (page, q) => page.locator(`#${cssEscape(q)}`)
  },
  {
    strategy: "text",
    confidence: 0.9,
    build: (page, q) => page.getByText(q, { exact: true })
  },
  {
    strategy: "role",
    confidence: 0.85,
    build: (page, q) => {
      const roleMatch = /^role:(\w+)(?:\/(.+))?$/i.exec(q);
      if (roleMatch) {
        const role = roleMatch[1]!;
        const name = roleMatch[2];
        return name
          ? page.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact: true })
          : page.getByRole(role as Parameters<Page["getByRole"]>[0]);
      }
      return page.getByRole("button", { name: q, exact: true });
    }
  },
  {
    strategy: "partialText",
    confidence: 0.75,
    build: (page, q) => page.getByText(q, { exact: false })
  }
];

function isDomId(value: string): boolean {
  return /^[A-Za-z][\w-]*$/.test(value);
}

function cssEscape(id: string): string {
  return id.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

export class DefaultLocatorResolver implements LocatorResolver {
  async resolve(
    page: Page,
    query: LocatorQuery,
    index?: number
  ): Promise<{ locator: Locator; match: LocatorMatch }> {
    const trimmed = query.trim();
    const strategies = trimmed.startsWith("role:")
      ? STRATEGIES.filter(s => s.strategy === "role")
      : STRATEGIES.filter(s => s.strategy !== "id" || isDomId(trimmed));
    const pick = index ?? 0;
    for (const s of strategies) {
      try {
        const locator = s.build(page, trimmed);
        const count = await locator.count();
        if (count > pick) {
          return {
            locator: pick > 0 ? locator.nth(pick) : locator.first(),
            match: { strategy: s.strategy, value: trimmed, confidence: s.confidence }
          };
        }
      } catch {
        // try the next strategy
      }
    }
    throw new Error(`No element matched locator: ${query}`);
  }
}

export const defaultLocatorResolver = new DefaultLocatorResolver();
