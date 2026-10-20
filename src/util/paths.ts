import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}
