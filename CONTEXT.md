# pi-uv-redirect

A pi extension that intercepts `powershell` tool calls (pi's built-in
PowerShell tool on Windows) and
redirects Python tooling to `uv`, before the command reaches PowerShell.

## Language

**Interceptor**:
A pi extension that listens to the `tool_call` event for the `powershell` tool and
blocks or rewrites the command string before it executes.
_Avoid_: Wrapper, shim wrapper

**Block-with-guidance**:
Refuse to execute a matched command and return an error string that teaches the
`uv` equivalent; the model re-issues the corrected command.
_Avoid_: Hard block, reject

**Silent redirect**:
Rewrite a matched bare-interpreter invocation to its `uv run` form in place,
letting the command execute without surfacing the rewrite to the model.
_Avoid_: Rewrite-and-run, auto-redirect

**Segment**:
A maximal span of a PowerShell command delimited by `;`, `&&`, `||`, `|`, a
newline, or a trailing background `&`; conceptually the unit at which a command
name resolves. With the parser approach the matcher operates on `CommandAst`
positions, which correspond exactly to segment-leader command positions.

**Pre-filter**:
A cheap JavaScript regex over the raw command string run before spawning the
PowerShell parser. If it finds no `python`/`python3`/`pip`/`pip3`/`poetry` word,
the handler returns without parsing, so the vast majority of `powershell` calls pay
no parser cost.

**Parser pass**:
Spawning `pwsh -NoProfile` to run
`[System.Management.Automation.Language.Parser]::ParseInput($command, [ref]$null)`
and walking `CommandAst` nodes for command-position names with their string
offsets, so redirect splices and block matches land on real command positions
even inside here-strings and array literals.

**Top-parse-surface scope (the extension's contract)**:
Only `python`/`python3`/`pip`/`pip3`/`poetry` that appear as a command-position
`CommandAst` at the top parse surface of the `powershell` command string are
intercepted. Explicit-path invocations (`.\x\python.exe ...`), the Windows `py`
launcher, and bare names buried inside strings that another command later
dynamically re-evaluates (`Invoke-Expression "python x"`, `Start-Pty -Command`,
runtime-built script blocks) are accepted leaks and serve as the deliberate
escape hatch. This single boundary unifies the explicit-path, `py`, and
dynamic-eval decisions.

**Fail-open (parser-failure policy)**:
If the parser pass fails by infrastructure error (spawn failure, non-zero exit,
invalid JSON, or a parse-spawn timeout), the command passes through unmodified
and the user sees a transient `ctx.ui.notify` warning; the model is not told (it
would only harm retry logic). A user-command syntax error that produces no
`CommandAst` is not a failure — the command would have errored at execution
anyway, so it passes silently. Block-on-any-failure was rejected as an
availability hazard.

**Parse-spawn timeout value (Q11, corrected by measurement)**:
The cap is **4s**, not the 2s originally chosen in grilling. Measured (2025,
Windows + pwsh 7): a fresh `pwsh -NoProfile` spawn to run the parser takes
~2.3s cold (first spawn in a process; OS loads pwsh DLLs / CLR) and ~700ms
steady-state. The grilling estimated ~100ms parse; reality is dominated by the
full pwsh process spawn. 2s would trip the first parse in a session, leaking
the first Python command — a real correctness loss. 4s covers cold start with
margin while still rescuing a genuine hang inside ~4s. The steady-state ~700ms
is also a cost the grilling did not quantify: every pre-filter-matching command
(mentions python/pip/poetry) pays one pwsh spawn. The pre-filter keeps
non-Python commands at ~0; only Python-related commands pay. A warm long-lived
pwsh parse worker would remove both the cold-start and the per-call ~700ms but
is deferred (protocol/lifecycle complexity) for v0.1.

**Recognizable exact-name set**:
The matcher acts only when a `CommandAst` name, lowercased, is exactly one of
`python`, `python3`, `pip`, `pip3`, `poetry`. Redirect is limited to `python` /
`python3` (per the locked scope); `pip`/`pip3`/`poetry` block; `python`/`python3`
carrying `-m pip`/`-m venv`/`-m py_compile` block. Because matching is by
exact set, explicit-path invocations (`.\\python.exe`, `C:\Python\python.exe`),
versioned/exe variants (`python3.12`, `python.exe`), and unrelated commands
(`pythonista`, `py`) all naturally fail to match and become the escape hatch —
no separate bare/explicit-path classifier is needed. This is a deliberate
narrowing from uv.ts's broader regex (`python3.12`, `python.exe`), which was a
PATH-shim artifact; under the parser + exact set it is out of scope.

**Command-position distinction (replaces the upstream-`uv` skip)**:
The matcher only ever acts on a token that is a `CommandAst` name — a
command-position token. In `uv run python x` and `uv pip install x`, `python`
and `pip` are *argument* tokens of the one `CommandAst` named `uv`, not
command positions themselves, so the matcher never sees them. Double-redirect
(`uv run uv run python`) and mis-block (`uv pip install x` blocked) are therefore
impossible by construction — the parser's command-position distinction does the
work that uv.ts's explicit upstream-`uv` skip did.

The earlier design's upstream-`uv` skip ("skip when the immediate left
pipeline-segment neighbor is `CommandAst` named `uv`") was dropped because it
is redundant under the parser approach *and* harmful: in a real pipeline like
`uv pip install x | python process.py`, segment 2's `python` has `uv` as its
left neighbor and the skip would silently drop a redirect that should fire.
The skip was modeled on uv.ts's regex/shim world, where `python` anywhere at a
segment start gets shimmed and a preceding `uv` can't be told apart from
unrelated context; the parser can tell them apart, so the skip is not ported.
`uvx` and `uv tool run` are different commands and the `uvx python` case does
not arise in practice.

**Inactive notice**:
The extension loads unconditionally but only intercepts the `powershell` tool. On
`session_start`, after a `setImmediate` deferral so pi's async tool registration
has settled, it checks `pi.getActiveTools()` for `powershell`; if absent it emits a
one-time `ctx.ui.notify` warning that uv-redirect is inactive. This keeps "I'm silently inert" from masquerading as "I'm protecting
you," consistent with the fail-open transparency posture.

**Case-insensitivity (platform-driven)**:
NTFS and PowerShell resolve command names case-insensitively, so
`Python`, `PIP`, `Pip` all run. The matcher compares `CommandAst` names and
the `-m`-target names case-insensitively; uv.ts's case-sensitive regex was
correct on case-sensitive filesystems but would leak `Python -m pip` here.

**`-m` argument forms**:
The block side treats `python -m pip`/`-m venv`/`-m py_compile` as block when an
arg is `-m` (case-insensitive) followed by a
`pip`/`venv`/`py_compile`-matching arg (two-token form) OR a single arg matches
`/^-m(?:pip|venv|py_compile)$/i` (glued `-mpip` form, one token). The
`-m:pip` colon-separated form is deliberately not matched — too far into the
long tail for a platform whose common forms are the other two.