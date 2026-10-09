import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { DriverKind } from "../types.js";
import type { DriverContext } from "./types.js";
import { PlaywrightBaseDriver } from "./playwright-base.js";

export class ChromiumDriver extends PlaywrightBaseDriver {
  readonly kind: DriverKind = "chromium";

  async connect(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    const url = ctx.fixtureUrl;
    if (!url) {
      throw new Error("Chromium driver requires fixtureUrl in context");
    }
    const target = url.startsWith("file:") || url.includes("://") ? url : pathToFileURL(resolve(url)).href;
    await this.launchChromium(ctx.headless ?? true, target);
  }
}
