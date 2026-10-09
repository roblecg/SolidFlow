import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { FlowError } from "../types.js";

export type FlowScriptState = {
  output: Record<string, unknown>;
  copiedText: string;
};

export function createScriptState(): FlowScriptState {
  return { output: {}, copiedText: "" };
}

export function evalFlowExpression(
  state: FlowScriptState,
  source: string,
  env: Record<string, string>
): unknown {
  const code = unwrapExpression(source);
  if (!code) throw new FlowError("Script is empty");
  const clipboard = { copiedText: state.copiedText };
  const sandbox = {
    output: state.output,
    solidflow: clipboard,
    maestro: clipboard,
    env: { ...env },
    SOLIDFLOW_PLATFORM: "Web",
    MAESTRO_PLATFORM: "Web",
    console
  };
  try {
    return vm.runInNewContext(code, sandbox, { timeout: 5_000 });
  } catch (err) {
    if (err instanceof FlowError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new FlowError(`Script failed: ${message}`);
  }
}

export async function runScriptFile(
  state: FlowScriptState,
  flowDir: string,
  file: string,
  env: Record<string, string>
): Promise<unknown> {
  const abs = resolve(flowDir, file);
  const rel = relative(flowDir, abs);
  if (rel.startsWith("..") || rel === "") {
    throw new FlowError("runScript path must stay inside the flow directory");
  }
  let source: string;
  try {
    source = await readFile(abs, "utf8");
  } catch {
    throw new FlowError(`runScript file not found: ${file}`);
  }
  return evalFlowExpression(state, source, env);
}

export function unwrapExpression(source: string): string {
  const trimmed = source.trim();
  const wrapped = /^\$\{([\s\S]*)\}$/.exec(trimmed);
  return (wrapped ? wrapped[1] : trimmed).trim();
}
