import { test } from "node:test";
import assert from "node:assert/strict";

import { preFilter, processCommand } from "../src/index.ts";
import type { ParseResult } from "../src/parse.ts";

// Helpers: fabricate ParseResults (the parser+decide layers are covered by
// their own tests; here we test the orchestration that sits between them).
const ok = (records: { name: string; offset: number; args?: string[] }[]): ParseResult =>
  ({ ok: true, records: records.map((r) => ({ name: r.name, offset: r.offset, args: r.args ?? [] })) });
const fail = (errorKind: ParseResult["errorKind"]): ParseResult =>
  ({ ok: false, errorKind });

const PIP_REASON =
  "Error: pip is disabled. Use uv instead:\n\n To install a package for a script: uv run --with PACKAGE python script.py\n To add a dependency to the project: uv add PACKAGE\n";

// preFilter ---------------------------------------------------------------

test("preFilter matches python words", () => {
  assert.equal(preFilter("python x.py"), true);
  assert.equal(preFilter("python3 -m venv .venv"), true);
  assert.equal(preFilter("pip install x"), true);
  assert.equal(preFilter("pip3 install x"), true);
  assert.equal(preFilter("poetry add x"), true);
});

test("preFilter skips non-Python commands", () => {
  assert.equal(preFilter("Get-ChildItem -Recurse"), false);
  assert.equal(preFilter("echo hello"), false);
  assert.equal(preFilter(""), false);
  assert.equal(preFilter("git status"), false);
  assert.equal(preFilter("uv run python x.py"), true); // mentions python -> parse (correctly)
});

test("preFilter uses word boundaries", () => {
  // 'pythonic' should not match \bpython3?\b at a word boundary start; but
  // \bpython\b would not match 'pythonic' because no boundary after python.
  assert.equal(preFilter("pythonic x"), false);
  assert.equal(preFilter("pip3x"), false);
});

// processCommand: redirect ------------------------------------------------

test("processCommand redirect returns rewritten command", () => {
  const out = processCommand("python script.py", ok([{ name: "python", offset: 0, args: ["script.py"] }]));
  assert.equal(out.kind, "redirect");
  if (out.kind === "redirect") assert.equal(out.command, "uv run python script.py");
});

test("processCommand redirect with offset > 0 splices correctly", () => {
  // 'Get-ChildItem; python a.py' -> python at offset 15
  const out = processCommand("Get-ChildItem; python a.py", ok([
    { name: "Get-ChildItem", offset: 0, args: [] },
    { name: "python", offset: 15, args: ["a.py"] },
  ]));
  assert.equal(out.kind, "redirect");
  if (out.kind === "redirect") assert.equal(out.command, "Get-ChildItem; uv run python a.py");
});

// processCommand: block ---------------------------------------------------

test("processCommand block returns uv guidance", () => {
  const out = processCommand("pip install x", ok([{ name: "pip", offset: 0, args: ["install", "x"] }]));
  assert.equal(out.kind, "block");
  if (out.kind === "block") assert.equal(out.reason, PIP_REASON);
});

test("processCommand block (python -m pip) wins over redirect siblings", () => {
  const out = processCommand("python -m pip install x ; python y.py", ok([
    { name: "python", offset: 0, args: ["-m", "pip", "install", "x"] },
    { name: "python", offset: 25, args: ["y.py"] },
  ]));
  assert.equal(out.kind, "block");
});

// processCommand: passthrough & fail-open ---------------------------------

test("processCommand passthrough when no record matches", () => {
  const out = processCommand("Get-ChildItem", ok([{ name: "Get-ChildItem", offset: 0, args: [] }]));
  assert.equal(out.kind, "passthrough");
});

test("processCommand fail-open passthrough on parser spawn error", () => {
  assert.equal(processCommand("python x.py", fail("spawn")).kind, "passthrough");
});

test("processCommand fail-open passthrough on parser exit error", () => {
  assert.equal(processCommand("python x.py", fail("exit")).kind, "passthrough");
});

test("processCommand fail-open passthrough on parser timeout", () => {
  assert.equal(processCommand("python x.py", fail("timeout")).kind, "passthrough");
});

test("processCommand fail-open passthrough on invalid JSON", () => {
  assert.equal(processCommand("python x.py", fail("json")).kind, "passthrough");
});

test("processCommand fail-open does NOT block even for an obviously-bad command", () => {
  // Critical: a parser failure must never become a block. The fail-open
  // contract is "pass through unmodified", never "refuse to run".
  const out = processCommand("pip install malware", fail("json"));
  assert.equal(out.kind, "passthrough");
});

// processCommand: escape hatch flows through as passthrough ---------------

test("processCommand: uv pip install (python is arg) -> passthrough", () => {
  const out = processCommand("uv pip install x", ok([{ name: "uv", offset: 0, args: ["pip", "install", "x"] }]));
  assert.equal(out.kind, "passthrough");
});

test("processCommand: python inside string (single CommandAst) -> passthrough", () => {
  const out = processCommand('Invoke-Expression "python x"', ok([
    { name: "Invoke-Expression", offset: 0, args: ['"python x"'] },
  ]));
  assert.equal(out.kind, "passthrough");
});

test("processCommand: py launcher -> passthrough (out of scope)", () => {
  const out = processCommand("py script.py", ok([{ name: "py", offset: 0, args: ["script.py"] }]));
  assert.equal(out.kind, "passthrough");
});