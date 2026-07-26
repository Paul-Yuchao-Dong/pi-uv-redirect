# pi-uv-redirect

A pi extension that sits in front of [`pi-pwsh`](https://github.com/andi0b/pi-pwsh)'s
`pwsh` tool and redirects Python tooling to [`uv`](https://docs.astral.sh/uv/) before
the command reaches PowerShell.

It is a Windows, pi-pwsh-concurrent port of
[mitsuhiko's `uv.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/uv.ts).
That extension wraps the **`bash`** tool to prepend PATH shims and a `spawnHook` —
which doesn't work on this stack, because pi-pwsh disables `bash` and registers a
`pwsh` tool whose spawn layer uvt cannot reach. See
[`docs/adr/0001-intercept-at-tool-call-in-front-of-pi-pwsh.md`](./docs/adr/0001-intercept-at-tool-call-in-front-of-pi-pwsh.md)
for why this extension intercepts at pi's `tool_call` event instead.

## What it does

- **Block-with-guidance** for `pip`/`pip3`/`poetry` and for
  `python -m pip` / `python -m venv` / `python -m py_compile` (and `python3 …`).
  The tool call is refused and the model is told the `uv` equivalent, so it
  re-issues the corrected command.
- **Silent redirect** for bare `python`/`python3` running a script → rewritten to
  `uv run python …` in place, before execution.
- **Matcher** uses PowerShell's own
  [`System.Management.Automation.Language.Parser`](https://learn.microsoft.com/en-us/powershell/scripting/dev-cross-plat/choosing-the-right-nuget-package?view=powershell-7.4)
  to find command-position names, so here-strings, single-quoted strings, and
  array literals are not mistaken for commands. A cheap JS pre-filter skips
  polling the parser for commands that don't mention Python at all.

## Scope (the contract)

Only `python`/`python3`/`pip`/`pip3`/`poetry` appearing as a command-position
`CommandAst` at the **top parse surface** of the `pwsh` command string are
intercepted. The following are accepted leaks and serve as the deliberate escape
hatch (see `CONTEXT.md`, *Top-parse-surface scope*):

- explicit interpreter paths (`.\.venv\Scripts\python.exe …`),
- the Windows `py` launcher (any form),
- bare names buried inside strings re-evaluated by another command
  (`Invoke-Expression "python x"`, `Start-Pty -Command`, runtime-built script blocks).

`uv …` invocations already written by the model are left alone (no double
redirect, no `uv pip` mis-block).

## Failure mode (fail open)

If the parser pass fails by infrastructure error (spawn failure, non-zero exit,
invalid JSON, or a 4s timeout), the command passes through **unmodified** and the
user gets a transient notification; the model is not told. Syntax errors in the
user's command pass silently — `pwsh` will surface them at execution time.

> **Latency note:** each command that passes the pre-filter (mentions
> `python`/`pip`/`poetry`) pays one `pwsh` spawn (~700ms steady-state, ~2.3s
> cold first spawn per session). Non-Python commands pay nothing (the pre-filter
> skips the parse). This is the cost of using PowerShell's real parser instead
> of a regex.

## Requirements

- [`pi-pwsh`](https://github.com/andi0b/pi-pwsh) installed and active (provides
  the `pwsh` tool). If pi-pwsh isn't running, this extension is inert and tells
  you once on session start.
- `pwsh` (PowerShell 7+) on PATH.

## Install

With pi:

```
pi install npm:@paulcynic/pi-uv-redirect
```

Or from source:

```
pi install git:github.com/Paul-Yuchao-Dong/pi-uv-redirect
```

Or symlink/copy into `~/.pi/agent/extensions/`.

## License

MIT