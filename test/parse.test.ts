import { test } from "node:test";
import assert from "node:assert/strict";

import { runParser, parseScriptExists, type ParseOptions } from "../src/parse.ts";

// Most tests use the REAL pwsh parse script (happy path + escape hatch), since
// pwsh is available on this machine. Failure modes use an injected spawner to
// avoid relying on a real hang.

const pythonScript = "python x.py";

test("real pwsh: bare python -> one record, offset 0", async () => {
  const r = await runParser(pythonScript);
  assert.equal(r.ok, true);
  assert.ok(r.records);
  assert.equal(r.records!.length, 1);
  assert.equal(r.records![0].name, "python");
  assert.equal(r.records![0].offset, 0);
  assert.deepEqual(r.records![0].args, ["x.py"]);
});

test("real pwsh: pip install requests -> one record", async () => {
  const r = await runParser("pip install requests");
  assert.equal(r.ok, true);
  assert.equal(r.records!.length, 1);
  assert.equal(r.records![0].name, "pip");
  assert.deepEqual(r.records![0].args, ["install", "requests"]);
});

test("real pwsh: uv run python x.py -> one CommandAst (python is arg)", async () => {
  const r = await runParser("uv run python x.py");
  assert.equal(r.ok, true);
  assert.equal(r.records!.length, 1);
  assert.equal(r.records![0].name, "uv");
  assert.deepEqual(r.records![0].args, ["run", "python", "x.py"]);
});

test("real pwsh: pipeline uv pip | python -> two records, python redirectable", async () => {
  const r = await runParser("uv pip install x | python p.py");
  assert.equal(r.ok, true);
  assert.equal(r.records!.length, 2);
  assert.equal(r.records![0].name, "uv");
  assert.equal(r.records![1].name, "python");
  assert.equal(r.records![1].offset, 19); // python starts at offset 19
});

test("real pwsh: python inside a string -> NOT a CommandAst (escape hatch)", async () => {
  const r = await runParser('Invoke-Expression "python x"');
  assert.equal(r.ok, true);
  assert.equal(r.records!.length, 1);
  assert.equal(r.records![0].name, "Invoke-Expression");
});

test("real pwsh: empty input -> ok, empty records", async () => {
  const r = await runParser("");
  assert.equal(r.ok, true);
  assert.deepEqual(r.records, []);
});

test("real pwsh: invalid user syntax -> ok (errors are user-side, silent)", async () => {
  const r = await runParser("pip |");
  assert.equal(r.ok, true);
});

// Failure modes via injected spawners ----------------------------------

const injecting = (
  impl: (input: { command: string; timeoutMs: number }) =>
    Promise<{ stdout: string; code: number }>,
): ParseOptions => ({
  spawn: async (input) =>
    impl({ command: input.command, timeoutMs: input.timeoutMs }),
});

test("invalid JSON -> fail-open errorKind json", async () => {
  const r = await runParser("python x.py", injecting(async () => ({ stdout: "not json", code: 0 })));
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, "json");
});

test("non-zero exit -> fail-open errorKind exit", async () => {
  const r = await runParser("python x.py", injecting(async () => ({ stdout: "", code: 1 })));
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, "exit");
});

test("spawner throws -> fail-open errorKind spawn", async () => {
  const r = await runParser("python x.py", injecting(async () => { throw new Error("ENOENT"); }));
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, "spawn");
});

test("hanging spawner -> fail-open errorKind timeout (small timeoutMs)", async () => {
  const r = await runParser("python x.py", {
    timeoutMs: 40,
    spawn: async () => new Promise(() => { /* never resolves */ }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, "timeout");
});

test("real pwsh: 'py' launcher is not intercepted (record name py, not in set)", async () => {
  const r = await runParser("py -3 script.py");
  assert.equal(r.ok, true);
  assert.equal(r.records!.length, 1);
  assert.equal(r.records![0].name, "py"); // decide() will skip it; parse reports it
});

test("bundled parse.ps1 exists next to the driver module", () => {
  assert.equal(parseScriptExists(), true);
});