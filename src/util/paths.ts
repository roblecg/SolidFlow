import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}

/** Practice login shipped with the app. It is not a workspace. */
export function fixturePageUrl(): string {
  return pathToFileURL(join(packageRoot(), "src/studio/public/fixture.html")).href;
}
