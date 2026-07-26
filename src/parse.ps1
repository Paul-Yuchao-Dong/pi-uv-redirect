# pi-uv-redirect parser pass.
#
# Reads a PowerShell command string from stdin, parses it with the built-in
# System.Management.Automation.Language.Parser, and emits one JSON array of
# command records on stdout. Each record is:
#
#   { "name": "<as-typed command name>", "offset": <int>, "args": ["...", ...] }
#
# where `offset` is the 0-based start offset of the command name token in the
# input string (for splicing "uv run " before it) and `args` are the texts of
# every command element after the name (parameters and arguments, as typed).
#
# Design notes:
#   * We walk every CommandAst the parser reports. A token that is quoted
#     ("python"), built from a string at runtime ([scriptblock]::Create($s)),
#     or passed to Invoke-Expression/Start-Pty is NOT a CommandAst, so it never
#     appears here — that is the "top parse surface" contract in CONTEXT.md.
#   * ParseInput is error-tolerant: it returns an AST even for commands with
#     user syntax errors. We do NOT treat $errors as failure — the command will
#     surface its own errors when pwsh actually runs it, which is the fail-open
#     "user-command syntax errors pass silently" policy.
#   * ONLY JSON is written to stdout, so the driver can treat invalid JSON as
#     an infrastructure failure (spawn/exit/timeout) and fail-open with a
#     user-only notification.
#
# Invocation: pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass
#             -File parse.ps1   (with the command piped on stdin)

$ErrorActionPreference = 'Stop'

$command = [Console]::In.ReadToEnd()

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput(
    $command, [ref]$tokens, [ref]$errors)

$records = @()

if ($null -ne $ast) {
    $commands = $ast.FindAll(
        { param($node) $node -is [System.Management.Automation.Language.CommandAst] },
        $true
    )
    foreach ($c in $commands) {
        $elements = $c.CommandElements
        if ($null -eq $elements -or $elements.Count -eq 0) { continue }
        $nameEl = $elements[0]
        $name = $nameEl.Extent.Text
        $offset = $nameEl.Extent.StartOffset
        $args = @()
        for ($i = 1; $i -lt $elements.Count; $i++) {
            $args += $elements[$i].Extent.Text
        }
        $records += [pscustomobject]@{
            name   = $name
            offset = $offset
            args   = $args
        }
    }
}

if ($records.Count -eq 0) {
    Write-Output -NoEnumerate '[]'
} else {
    Write-Output -NoEnumerate (ConvertTo-Json -InputObject $records -Compress -Depth 6)
}