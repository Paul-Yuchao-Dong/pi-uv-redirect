// pi-uv-redirect entry point.
//
// Registers two pi hooks:
//   - tool_call on "powershell": pre-filter -> parser pass -> decide -> block or
//     redirect (mutate event.input.command in place) or passthrough (incl.
//     fail-open on any parser infrastructure failure, with a user-only notify).
//   - session_start: after setImmediate, if pi's built-in "powershell" tool is
//     not in pi.getActiveTools(), emit a one-time inactive notice.
//     PI_UV_REDIRECT_DEBUG=1 also traces the startup tool-set timeline to
//     PI_UV_REDIRECT_LOG (default <TEMP>/pi-uv-redirect.log), because another
//     extension can narrow the active set for ~1s mid-startup (pi-herdsman does)
//     and a single snapshot then reports "inert" for a tool that is active.
//
// The orchestration core (preFilter / processCommand) is pure and exported so it
// can be unit-tested without a pi runtime. The parser pass comes from parse.ts;
// the decision layer from decide.ts.
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { decide, applySplices } from "./decide.ts";
import { runParser, type ParseResult } from "./parse.ts";

// Startup trace, off unless asked for. Logging must never break a tool call, so
// every failure here is swallowed.
const DEBUG = process.env.PI_UV_REDIRECT_DEBUG === "1";
const DEBUG_LOG =
  process.env.PI_UV_REDIRECT_LOG ?? join(tmpdir(), "pi-uv-redirect.log");

function trace(tag: string, data: unknown): void {
  if (!DEBUG) return;
  try {
    appendFileSync(
      DEBUG_LOG,
      `${new Date().toISOString()} pid=${process.pid} ${tag} ${JSON.stringify(data)}\n`,
    );
  } catch {
    // ignore: tracing is best-effort
  }
}

// Pre-filter: a cheap regex over the raw command before spawning the parser.
// Returns true if the command MIGHT contain an interceptable bare name, i.e.
// we should run the parser. False negatives would skip interception (correctness
// bug), so this matches generously; false positives only cost a parse spawn.
// Word boundaries keep "pythonic" / "pip3x" / "poetry-core" from over-spawning
// in the common case, but even a false positive is harmless (the parser will
// not report a matching CommandAst and we passthrough).
const PREFILTER = /\b(?:python3?|pip3?|poetry)\b/i;

export function preFilter(command: string): boolean {
  return PREFILTER.test(command);
}

export type ProcessOutcome =
  | { kind: "passthrough" }
  | { kind: "block"; reason: string }
  | { kind: "redirect"; command: string };

/**
 * Given the raw command and the parser-pass result, produce the outcome the
 * tool_call handler should apply. Pure (no I/O, no pi types) so it is the unit
 * test seam for the orchestration that sits between the parser and the tool_call
 * event.
 *
 * Fail-open: any non-ok parser result becomes passthrough (the handler is
 * responsible for the user-only notify; this function does not surface errors).
 */
export function processCommand(
  command: string,
  parserResult: ParseResult,
): ProcessOutcome {
  if (!parserResult.ok || !parserResult.records) {
    return { kind: "passthrough" };
  }
  const d = decide(parserResult.records);
  switch (d.action) {
    case "passthrough":
      return { kind: "passthrough" };
    case "block":
      return { kind: "block", reason: d.reason };
    case "redirect":
      return { kind: "redirect", command: applySplices(command, d.splices) };
  }
}

let inactiveNotified = false;

// Records every change of the active tool set for the first 10s after startup, so
// a transient narrowing by another extension shows up as its own trace line.
function traceToolSetChanges(pi: ExtensionAPI): void {
  const startedAt = Date.now();
  let last: string | undefined;
  const tick = (): void => {
    let tools: string[];
    try {
      tools = pi.getActiveTools() ?? [];
    } catch (error) {
      trace("tools_error", {
        atMs: Date.now() - startedAt,
        error: String(error),
      });
      return;
    }
    const signature = tools.join(",");
    if (signature !== last) {
      last = signature;
      trace("tools_changed", {
        atMs: Date.now() - startedAt,
        count: tools.length,
        hasPowershell: tools.includes("powershell"),
        tools,
      });
    }
    if (Date.now() - startedAt < 10_000) setTimeout(tick, 10);
  };
  setImmediate(tick);
}

export default function uvRedirect(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    const startedAt = Date.now();
    try {
      trace("session_start", {
        reason: (event as { reason?: string } | undefined)?.reason,
        tools: pi.getActiveTools() ?? [],
      });
    } catch {
      // getActiveTools may not be ready yet; the deferred check below reports it
    }
    if (DEBUG) traceToolSetChanges(pi);
    // Defer so pi's async tool registration has settled before we inspect
    // the active tool set. Without the deferral we'd race the registration and
    // could falsely report "inactive".
    setImmediate(() => {
      try {
        const active = pi.getActiveTools() ?? [];
        trace("startup_check", {
          atMs: Date.now() - startedAt,
          count: active.length,
          hasPowershell: active.includes("powershell"),
          tools: active,
        });
        if (!active.includes("powershell") && !inactiveNotified) {
          inactiveNotified = true;
          ctx.ui.notify(
            "pi-uv-redirect is inert: the powershell tool is not active. " +
              "Python redirecting to uv is disabled until the powershell tool is active.",
            "info",
          );
        } else if (active.includes("powershell")) {
          inactiveNotified = false; // powershell came back; allow a future notice again
        }
      } catch {
        // getActiveTools not ready yet — stay silent (will retry next session_start).
      }
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "powershell") return;
    const input = event.input as { command?: string } | undefined;
    const command = input?.command;
    if (typeof command !== "string" || command.length === 0) return;

    // Fast path: the vast majority of powershell calls don't mention Python tooling.
    if (!preFilter(command)) return;

    let parserResult: ParseResult;
    try {
      parserResult = await runParser(command, { signal: ctx.signal });
    } catch {
      // Uncaught parser error: fail-open, notify user, don't tell the model.
      ctx.ui.notify(
        "pi-uv-redirect: parser pass failed unexpectedly; command passed through unmodified.",
        "info",
      );
      return;
    }

    if (!parserResult.ok) {
      // Fail-open with user-only notify; the model is not told.
      ctx.ui.notify(
        `pi-uv-redirect: parser pass failed (${parserResult.errorKind ?? "unknown"}); command passed through unmodified.`,
        "info",
      );
      return;
    }

    const outcome = processCommand(command, parserResult);
    switch (outcome.kind) {
      case "passthrough":
        return;
      case "block":
        return { block: true, reason: outcome.reason };
      case "redirect":
        // Mutate in place; pi uses event.input at execution time.
        (event.input as { command: string }).command = outcome.command;
        return;
    }
  });
}