import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type CommandRecord,
  decide,
  applySplices,
  blockReason,
} from "../src/decide.ts";

// Helpers ---------------------------------------------------------------

const rec = (
  name: string,
  offset: number,
  args: string[] = [],
): CommandRecord => ({ name, offset, args });

// Independent source of truth for block guidance strings: uv.ts
// https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/uv.ts
const PIP_REASON =
  "Error: pip is disabled. Use uv instead:\n\n To install a package for a script: uv run --with PACKAGE python script.py\n To add a dependency to the project: uv add PACKAGE\n";
const PIP3_REASON =
  "Error: pip3 is disabled. Use uv instead:\n\n To install a package for a script: uv run --with PACKAGE python script.py\n To add a dependency to the project: uv add PACKAGE\n";
const POETRY_REASON =
  "Error: poetry is disabled. Use uv instead:\n\n To initialize a project: uv init\n To add a dependency: uv add PACKAGE\n To sync dependencies: uv sync\n To run commands: uv run COMMAND\n";
const PY_M_PIP_REASON =
  "Error: 'python -m pip' is disabled. Use uv instead:\n\n To install a package for a script: uv run --with PACKAGE python script.py\n To add a dependency to the project: uv add PACKAGE\n";
const PY_M_VENV_REASON =
  "Error: 'python -m venv' is disabled. Use uv instead:\n\n To create a virtual environment: uv venv\n";
const PY_M_PYCOMPILE_REASON =
  "Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.\n\n To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null\n";

// Passthrough -----------------------------------------------------------

test("empty records -> passthrough", () => {
  assert.deepEqual(decide([]), { action: "passthrough" });
});

test("unknown command -> passthrough", () => {
  assert.deepEqual(decide([rec("Get-ChildItem", 0, ["-Recurse"])]), {
    action: "passthrough",
  });
});

// Block: package managers ----------------------------------------------

test("pip -> block with pip guidance", () => {
  const d = decide([rec("pip", 0, ["install", "requests"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, PIP_REASON);
});

test("pip3 -> block with pip3 guidance", () => {
  const d = decide([rec("pip3", 0, ["install", "requests"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, PIP3_REASON);
});

test("poetry -> block with poetry guidance", () => {
  const d = decide([rec("poetry", 0, ["add", "requests"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, POETRY_REASON);
});

// Redirect: bare interpreter -------------------------------------------

test("python script.py -> redirect", () => {
  const d = decide([rec("python", 0, ["script.py"])]);
  assert.equal(d.action, "redirect");
  if (d.action === "redirect") assert.deepEqual(d.splices, [0]);
});

test("python3 script.py -> redirect", () => {
  const d = decide([rec("python3", 0, ["script.py"])]);
  assert.equal(d.action, "redirect");
  if (d.action === "redirect") assert.deepEqual(d.splices, [0]);
});

// Block: python -m ------------------------------------------------------

test("python -m pip install x -> block (-m two-token)", () => {
  const d = decide([rec("python", 0, ["-m", "pip", "install", "x"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, PY_M_PIP_REASON);
});

test("python -m venv -> block (venv two-token)", () => {
  const d = decide([rec("python", 0, ["-m", "venv", ".venv"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, PY_M_VENV_REASON);
});

test("python -m py_compile f.py -> block (py_compile two-token)", () => {
  const d = decide([rec("python", 0, ["-m", "py_compile", "f.py"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, PY_M_PYCOMPILE_REASON);
});

test("python -mpip install x -> block (glued)", () => {
  const d = decide([rec("python", 0, ["-mpip", "install", "x"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, PY_M_PIP_REASON);
});

test("python -mvenv -> block (glued)", () => {
  const d = decide([rec("python", 0, ["-mvenv"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, PY_M_VENV_REASON);
});

test("python -m py_compile via glued -mpy_compile -> block", () => {
  const d = decide([rec("python", 0, ["-mpy_compile", "f.py"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, PY_M_PYCOMPILE_REASON);
});

// Case-insensitivity ----------------------------------------------------

test("PIP install (uppercase) -> block (case-insensitive)", () => {
  const d = decide([rec("PIP", 0, ["install", "x"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, "Error: pip is disabled. Use uv instead:\n\n To install a package for a script: uv run --with PACKAGE python script.py\n To add a dependency to the project: uv add PACKAGE\n");
});

test("Python script.py (mixed case) -> redirect", () => {
  const d = decide([rec("Python", 0, ["script.py"])]);
  assert.equal(d.action, "redirect");
});

test("python -m PIP (uppercase target) -> block (case-insensitive target)", () => {
  const d = decide([rec("python", 0, ["-m", "PIP", "install", "x"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, PY_M_PIP_REASON);
});

// Escape hatch: not in the exact set -----------------------------------

test("python3.12 -> passthrough (not in exact set)", () => {
  assert.deepEqual(decide([rec("python3.12", 0, ["x.py"])]), {
    action: "passthrough",
  });
});

test("python.exe -> passthrough (not in exact set)", () => {
  assert.deepEqual(decide([rec("python.exe", 0, ["x.py"])]), {
    action: "passthrough",
  });
});

test("explicit path .\\python.exe -> passthrough (not in exact set)", () => {
  assert.deepEqual(decide([rec(".\\python.exe", 0, ["x.py"])]), {
    action: "passthrough",
  });
});

test("py launcher -> passthrough (out of scope)", () => {
  assert.deepEqual(decide([rec("py", 0, ["x.py"])]), { action: "passthrough" });
});

test("pythonista -> passthrough (not in exact set)", () => {
  assert.deepEqual(decide([rec("pythonista", 0, []), rec("pythonista", 0)]), {
    action: "passthrough",
  });
});

test("python -m pip3 (non-word target) -> redirect (pip3 is not a -m target)", () => {
  // -m pip3 is NOT blocked (pip is matched via word boundary in uv.ts; pip3 is not)
  const d = decide([rec("python", 0, ["-m", "pip3", "install", "x"])]);
  assert.equal(d.action, "redirect");
});

test("python -m:pip (colon form) -> redirect (colon form excluded)", () => {
  const d = decide([rec("python", 0, ["-m:pip"])]);
  assert.equal(d.action, "redirect");
});

// Command-position distinction (no upstream-uv skip) -------------------

test("CommandAst named uv with arg pip -> passthrough (pip is an arg)", () => {
  assert.deepEqual(decide([rec("uv", 0, ["pip", "install", "x"])]), {
    action: "passthrough",
  });
});

test("CommandAst named uv with arg run/python -> passthrough", () => {
  assert.deepEqual(decide([rec("uv", 0, ["run", "python", "x.py"])]), {
    action: "passthrough",
  });
});

test("pipeline segments: uv pip | python -> redirect only python segment", () => {
  // Segment 1 is CommandAst 'uv' (skip); segment 2 is CommandAst 'python' (redirect).
  // No upstream-uv skip -> segment 2 redirects.
  const d = decide([rec("uv", 0, ["pip", "install", "x"]), rec("python", 24, ["p.py"])]);
  assert.equal(d.action, "redirect");
  if (d.action === "redirect") assert.deepEqual(d.splices, [24]);
});

// Multiple commands: block precedence / first block wins ----------------

test("first block wins over later redirects", () => {
  const d = decide([rec("pip", 0, ["install", "x"]), rec("python", 14, ["s.py"])]);
  assert.equal(d.action, "block");
  if (d.action === "block") assert.equal(d.reason, PIP_REASON);
});

test("two redirects -> both offsets", () => {
  const d = decide([rec("python", 0, ["a.py"]), rec("python3", 12, ["b.py"])]);
  assert.equal(d.action, "redirect");
  if (d.action === "redirect") assert.deepEqual(d.splices, [0, 12]);
});

// applySplices ---------------------------------------------------------

test("applySplices inserts 'uv run ' at each offset (desc, stable)", () => {
  // 'python3' begins at offset 14 in this string.
  const out = applySplices("python a.py ; python3 b.py", [0, 14]);
  assert.equal(out, "uv run python a.py ; uv run python3 b.py");
});

test("applySplices empty -> unchanged", () => {
  assert.equal(applySplices("echo hi", []), "echo hi");
});

test("applySplices single offset", () => {
  assert.equal(applySplices("python x.py", [0]), "uv run python x.py");
});

// blockReason helper ---------------------------------------------------

test("blockReason pip matches decide pip", () => {
  assert.equal(blockReason("pip"), PIP_REASON);
  assert.equal(blockReason("pip3"), PIP3_REASON);
  assert.equal(blockReason("poetry"), POETRY_REASON);
});

test("blockReason -m targets", () => {
  assert.equal(blockReason("python", "pip"), PY_M_PIP_REASON);
  assert.equal(blockReason("python", "venv"), PY_M_VENV_REASON);
  assert.equal(blockReason("python", "py_compile"), PY_M_PYCOMPILE_REASON);
});