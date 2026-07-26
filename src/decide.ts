// Pure decision layer for pi-uv-redirect.
//
// Takes the CommandAst records produced by the PowerShell parser pass and
// decides what to do: block with a uv guidance message, redirect by splicing
// "uv run " before a python command-position token, or pass through unchanged.
//
// This module is pure (no spawn, no I/O) so it is the unit-test seam.

/** A command-position token found by the parser, with its offset and args. */
export interface CommandRecord {
  /** Command name as typed (case preserved; matched case-insensitively). */
  name: string;
  /** Start offset of the name token in the original command string. */
  offset: number;
  /** Element texts after the command name (parameters and arguments). */
  args: string[];
}

/** The recognizer output for a single record. */
type Classify =
  | { type: "skip" }
  | { type: "block-pkg"; canonical: string }
  | { type: "block-m"; target: string }
  | { type: "redirect" };

export type Decision =
  | { action: "passthrough" }
  | { action: "block"; reason: string }
  | { action: "redirect"; splices: number[] };

// Exact-name set (case-insensitive). Deliberately narrow:
//   redirect: python / python3 only
//   block:    pip / pip3 / poetry (pkg managers) and python/python3 -m pip|venv|py_compile
// Anything else the parser reports (explicit paths, versioned/exe variants,
// py, pythonista, uv, ...) fails to match and becomes the escape hatch.
const REDIRECT_NAMES = new Set(["python", "python3"]);
const BLOCK_PKG_NAMES = new Set(["pip", "pip3", "poetry"]);
// `-m` targets blocked when a bare python/python3 runs them.
const M_TARGETS = new Set(["pip", "venv", "py_compile"]);
// Glued single-token form, e.g. "-mpip", "-mvenv", "-mpy_compile".
const GLUED_M = /^-m(?:pip|venv|py_compile)$/i;

function classify(rec: CommandRecord): Classify {
  const lower = rec.name.toLowerCase();

  if (BLOCK_PKG_NAMES.has(lower)) {
    return { type: "block-pkg", canonical: lower };
  }
  if (REDIRECT_NAMES.has(lower)) {
    const args = rec.args ?? [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      // two-token form: "-m" followed by a target
      if (a === "-m" && i + 1 < args.length) {
        const next = args[i + 1].toLowerCase();
        if (M_TARGETS.has(next)) {
          return { type: "block-m", target: next };
        }
      }
      // glued form: "-mpip" / "-mvenv" / "-mpy_compile"
      if (GLUED_M.test(a)) {
        const target = a.slice(2); // strip "-m"
        return { type: "block-m", target };
      }
    }
    return { type: "redirect" };
  }
  return { type: "skip" };
}

/**
 * Decide what to do with a command given its top parse-surface CommandAst
 * records. The first record (in parse order) that triggers a block wins and
 * short-circuits the whole tool call — consistent with uv.ts, which blocks the
 * entire command on the first match. Redirect offsets are collected from all
 * redirect records otherwise.
 */
export function decide(records: CommandRecord[]): Decision {
  const splices: number[] = [];
  for (const rec of records) {
    const c = classify(rec);
    switch (c.type) {
      case "block-pkg":
        return { action: "block", reason: blockReason(c.canonical) };
      case "block-m":
        return { action: "block", reason: blockReason("python", c.target) };
      case "redirect":
        splices.push(rec.offset);
        break;
      default:
        break;
    }
  }
  return splices.length
    ? { action: "redirect", splices }
    : { action: "passthrough" };
}

// blockReason -----------------------------------------------------------

const UV = "Use uv instead:";

function pkgBody(toScript: string, addToProject: string): string {
  return `${UV}\n\n To install a package for a script: ${toScript}\n To add a dependency to the project: ${addToProject}\n`;
}

export function blockReason(pkgOrPython: string, mTarget?: string): string {
  const canonical = pkgOrPython.toLowerCase();
  switch (canonical) {
    case "pip":
    case "pip3":
      return `Error: ${canonical} is disabled. ${pkgBody(
        "uv run --with PACKAGE python script.py",
        "uv add PACKAGE",
      )}`;
    case "poetry":
      return `Error: poetry is disabled. Use uv instead:\n\n To initialize a project: uv init\n To add a dependency: uv add PACKAGE\n To sync dependencies: uv sync\n To run commands: uv run COMMAND\n`;
    case "python": {
      switch (mTarget) {
        case "pip":
          return `Error: 'python -m pip' is disabled. ${pkgBody(
            "uv run --with PACKAGE python script.py",
            "uv add PACKAGE",
          )}`;
        case "venv":
          return `Error: 'python -m venv' is disabled. Use uv instead:\n\n To create a virtual environment: uv venv\n`;
        case "py_compile":
          return `Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.\n\n To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null\n`;
        default:
          throw new Error(
            `blockReason: python needs an -m target, got ${String(mTarget)}`,
          );
      }
    }
    default:
      throw new Error(`blockReason: unknown canonical ${canonical}`);
  }
}

// applySplices ---------------------------------------------------------

const REDIRECT_PREFIX = "uv run ";

/**
 * Insert "uv run " before each given offset. Offsets may be passed in any
 * order; they are applied from the end of the string backwards so earlier
 * offsets stay valid as the string grows. Duplicate offsets are removed.
 */
export function applySplices(command: string, splices: number[]): string {
  if (splices.length === 0) return command;
  const sorted = [...new Set(splices)].sort((a, b) => b - a); // descending
  let out = command;
  for (const off of sorted) {
    out = out.slice(0, off) + REDIRECT_PREFIX + out.slice(off);
  }
  return out;
}