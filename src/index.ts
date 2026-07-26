// pi-uv-redirect entry point.
//
// Registers two pi hooks:
//   - tool_call on "pwsh": pre-filter -> parser pass -> decide -> block or
//     redirect (mutate event.input.command in place) or passthrough (incl.
//     fail-open on any parser infrastructure failure, with a user-only notify).
//   - session_start: after setImmediate, if pi-pwsh's "pwsh" tool is not in
//     pi.getActiveTools(), emit a one-time inactive notice.
//
// The orchestration core (preFilter / processCommand) is pure and exported so it
// can be unit-tested without a pi runtime. The parser pass comes from parse.ts;
// the decision layer from decide.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { decide, applySplices } from "./decide.ts";
import { runParser, type ParseResult } from "./parse.ts";

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

export default function uvRedirect(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    // Defer so pi-pwsh's async tool registration has settled before we inspect
    // the active tool set. Without the deferral we'd race the registration and
    // could falsely report "inactive".
    setImmediate(() => {
      try {
        const active = pi.getActiveTools() ?? [];
        if (!active.includes("pwsh") && !inactiveNotified) {
          inactiveNotified = true;
          ctx.ui.notify(
            "pi-uv-redirect is inert: the pwsh tool is not active (pi-pwsh not running?). " +
              "Python redirecting to uv is disabled until pi-pwsh is active.",
            "info",
          );
        } else if (active.includes("pwsh")) {
          inactiveNotified = false; // pwsh came back; allow a future notice again
        }
      } catch {
        // getActiveTools not ready yet — stay silent (will retry next session_start).
      }
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "pwsh") return;
    const input = event.input as { command?: string } | undefined;
    const command = input?.command;
    if (typeof command !== "string" || command.length === 0) return;

    // Fast path: the vast majority of pwsh calls don't mention Python tooling.
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