# ADR 0001 — Intercept at `tool_call` in front of pi-pwsh

## Date

2025 — design session

## Status

Accepted

## Context

This extension is a Windows, pi-pwsh-concurrent port of
[mitsuhiko's `uv.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/uv.ts),
which redirects Python tooling to `uv`. `uv.ts` works by registering a **`bash`**
tool whose spawn layer (a) prepends a directory of PATH shims so bare
`python`/`pip`/`poetry` resolve to guidance-or-redirect scripts, and (b) a regex
`spawnHook` that throws a guidance error for the patterns the shims can't catch
(explicit-path `python -m pip`, etc.).

That approach does not work out of the box on this stack:

- [`pi-pwsh`](https://github.com/andi0b/pi-pwsh) disables the `bash` tool and
  registers a `pwsh` tool instead. There is no `bash` tool to wrap.
- pi-pwsh's `pwsh` tool owns its spawn layer completely
  (`createBashToolDefinition(cwd, { operations: { exec } })`); it exposes no
  `spawnHook`-style extension point and no env-injection hook. A companion
  extension cannot get inside it.
- The `pwsh` tool's input is `{ command: string; timeout?: number }`; there is no
  `env` field, so a PATH-shim approach would require mutating `process.env.PATH`
  globally at `session_start` — affecting every tool and every spawned process,
  racing pi-pwsh's own env setup, and on Windows fighting PATHEXT precedence
  (`pip.cmd` vs `pip.exe`).

## Decision

Intercept at pi's **`tool_call` event** for `toolName === "pwsh"`, mutating
`event.input.command` in place (for the silent-redirect half) or returning
`{ block: true, reason: <uv guidance> }` (for the block-with-guidance half).
Compose in front of pi-pwsh as an unrelated package; neither extension knows
about the other.

Rationale over the rejected alternatives:

- **Re-implement the pwsh spawn layer ourselves (own the `pwsh` tool).** Rejected:
  two `pwsh` tools collide, we'd have to disable pi-pwsh and lose its
  jobs/PTY/exit-code work, and the copy rots against upstream.
- **Mutate `process.env.PATH` at `session_start` (literal uv.ts port).** Rejected:
  Windows-fragile (PATHEXT, `.cmd`-vs-`.exe` precedence) and globally polluting
  (affects non-pwsh tools too); also load-order-dependent on pi-pwsh.

The `tool_call` event is load-order-independent (it fires regardless of which
extension registered `pwsh`), runs before any spawn, and gives us the command
string before PowerShell command resolution — so we don't need to subvert
resolution at all.

For the matcher, we use **PowerShell's own `System.Management.Automation.Language.Parser`**
via a short `pwsh -NoProfile` spawn, gated by a cheap JS regex pre-filter so
non-Python commands pay nothing. This is more correct than uv.ts's regex
(PowerShell here-strings, array literals, single-quoted strings all become
non-command AST nodes the parser naturally skips) and is the same parser
pi-pwsh itself trusts. The trade-off — added subprocess dependency and a
4s fail-open cap (covers a measured ~2.3s pwsh cold-start spawn) — is
documented in `CONTEXT.md` entries (pre-filter, parser pass, fail-open).

## Consequences

- Works in conjunction with pi-pwsh without forking it. pi-pwsh can be
  upgraded independently.
- Load-order-independent: does not depend on loading before or after pi-pwsh.
- Inert and self-describing when pi-pwsh is absent: an inactive notice fires on
  `session_start` (see `CONTEXT.md`: Inactive notice).
- The coverage boundary — top parse surface only — is the deliberate, documented
  escape hatch (explicit paths, `py`, dynamically-evaluated strings). See
  `CONTEXT.md`: Top-parse-surface scope.

## Note on the upstream-`uv` skip

An earlier design imported uv.ts's "skip when the immediate left pipeline-segment
neighbor is `uv`" guard to prevent double-redirect and `uv pip` mis-block. It
was **dropped** after the parser approach was chosen: the matcher only acts on
`CommandAst` names (command-position tokens), so in `uv run python x` and
`uv pip install x` the `python`/`pip` tokens are arguments of the one
`CommandAst` named `uv` and are never seen. The skip is redundant under the
parser and harmful in real pipelines (`uv pip install x | python process.py`),
where it would silently drop a redirect that should fire. See `CONTEXT.md`:
Command-position distinction.