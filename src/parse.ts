// Parser-pass driver: spawn pwsh to run parse.ps1, collect JSON CommandAst
// records, and classify infrastructure failures for the fail-open policy.
//
// Failure handling (see CONTEXT.md "Fail-open"): spawn error, non-zero exit,
// invalid JSON, or a 4s timeout all yield { ok:false, errorKind }. The tool_call
// handler then passes the command through unmodified and notifies the user.
// On timeout the wedged pwsh is reclaimed with `taskkill /T /F`, mirroring
// pi-pwsh's Windows tree-kill (we copy the pattern; we do not depend on
// pi-pwsh internals).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandRecord } from "./decide.ts";

export type ErrorKind = "spawn" | "exit" | "timeout" | "json";

export interface ParseResult {
  ok: boolean;
  records?: CommandRecord[];
  errorKind?: ErrorKind;
}

export interface SpawnInput {
  command: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type Spawner = (input: SpawnInput) => Promise<{ stdout: string; code: number }>;

export interface ParseOptions {
  /** Hard cap on the parse spawn (default 2000ms). */
  timeoutMs?: number;
  /** Path to parse.ps1; defaults to the sibling of this module. */
  parseScriptPath?: string;
  /** Inject a spawner for tests (bypasses real pwsh). */
  spawn?: Spawner;
  /** CallerAbortSignal (e.g. ctx.signal from the tool_call handler). */
  signal?: AbortSignal;
}

/**
 * Default cap on the parse spawn. Measured (2025, Windows + pwsh 7):
 *   - cold-start first spawn in a process: ~2.3s (OS loads pwsh DLLs / CLR)
 *   - steady-state: ~700ms per parse (a full pwsh process spawn, not just
 *     ParseInput — the grilling estimated ~100ms; reality is a full spawn)
 * 4s covers the observed cold start with margin while still rescuing a genuine
 * hang inside a human-imperceptible-ish window. The pre-filter keeps
 * non-Python commands at ~0 cost; only pre-filter matches pay the ~700ms.
 */
export const DEFAULT_TIMEOUT_MS = 4000;

export function defaultScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "parse.ps1");
}

/** Windows tree-kill: taskkill /T /F /PID — reclaim a wedged process tree. */
function treeKill(pid: number): void {
  if (!pid) return;
  try {
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // best-effort
  }
}

function defaultSpawner(scriptPath: string): Spawner {
  return ({ command, signal }) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
      );

      let stdout = "";
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });

      child.on("error", (err) => {
        finish(() => reject(err));
      });

      child.on("exit", (code) => {
        finish(() => resolve({ stdout, code: code ?? 0 }));
      });

      const onAbort = () => {
        if (!child.killed) treeKill(child.pid ?? 0);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdin.on("error", () => {
        finish(() => reject(new Error("stdin error")));
      });
      child.stdin.end(command, "utf8");
    });
}

function normalizeRecords(parsed: unknown): CommandRecord[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((r) => {
    const rec = r as Record<string, unknown>;
    return {
      name: String(rec?.name ?? ""),
      offset: Number(rec?.offset ?? 0),
      args: Array.isArray(rec?.args) ? rec.args.map(String) : [],
    };
  });
}

export async function runParser(
  command: string,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scriptPath = opts.parseScriptPath ?? defaultScriptPath();
  const spawner = opts.spawn ?? defaultSpawner(scriptPath);

  // Own an AbortController so the default spawner can tree-kill on timeout.
  const controller = opts.signal ? undefined : new AbortController();
  const signal = opts.signal ?? controller!.signal;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });

  let result: { stdout: string; code: number };
  try {
    result = await Promise.race([spawner({ command, timeoutMs, signal }), timeoutP]);
  } catch (e) {
    if (timer) clearTimeout(timer);
    const msg = (e as Error | undefined)?.message;
    return msg === "timeout"
      ? { ok: false, errorKind: "timeout" }
      : { ok: false, errorKind: "spawn" };
  }
  if (timer) clearTimeout(timer);

  if (result.code !== 0) return { ok: false, errorKind: "exit" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, errorKind: "json" };
  }
  return { ok: true, records: normalizeRecords(parsed) };
}

// Convenience for tests/sanity: confirm the bundled parse script exists.
export function parseScriptExists(path = defaultScriptPath()): boolean {
  return existsSync(path);
}