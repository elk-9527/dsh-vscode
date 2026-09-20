param([string]$Profile, [int]$Port, [string]$Patch, [string]$Out)
# Boot one kernel, wait for the door port, record the truth, then kill ONLY the
# process tree we started (taskkill /PID /T).
# Lesson (2026-09-19): never filter processes by command-line text and kill them --
# the pwsh running this very script has that text in its own command line.
# This file is ASCII-only on purpose: Windows PowerShell 5.1 parses .ps1 as ANSI,
# and non-ASCII comments can break the parse.
$bin = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path -LiteralPath $bin)) { throw "DSH CLI was not found: $bin" }
$lines = New-Object System.Collections.Generic.List[string]
function Note($t) { $lines.Add($t); $lines | Out-File -FilePath $Out -Encoding utf8 }

$log = "$env:TEMP\boot-$Profile.out.log"
$err = "$env:TEMP\boot-$Profile.err.log"
Remove-Item $log, $err -ErrorAction SilentlyContinue

$bootArgs = @($bin, '--profile', $Profile)
if ($Patch) { $bootArgs += @('--patch', $Patch) }
$bootArgs += @('--no-open', '--host', '127.0.0.1', '--port', '0')
$p = Start-Process -FilePath 'node' -ArgumentList $bootArgs -RedirectStandardOutput $log -RedirectStandardError $err -PassThru -WindowStyle Hidden
Note "pid=$($p.Id) profile=$Profile port=$Port patch=$Patch"

$opened = $false
$secs = 0
for ($i = 0; $i -lt 75; $i++) {
  if ($p.HasExited) { break }
  $t = New-Object System.Net.Sockets.TcpClient
  try { $t.Connect('127.0.0.1', $Port); $opened = $true; $t.Close(); $secs = $i; break } catch { Start-Sleep -Seconds 1 }
}

if ($p.HasExited) {
  Note "RESULT=EXITED code=$($p.ExitCode)"
} elseif ($opened) {
  Note "RESULT=UP door_open_after=${secs}s"
} else {
  Note "RESULT=ALIVE_NO_DOOR"
}
if (Test-Path $err) { $e = Get-Content $err -Encoding UTF8 -Tail 12; if ($e) { Note '--- stderr ---'; $e | ForEach-Object { Note "  $_" } } }
if (Test-Path $log) { $o = Get-Content $log -Encoding UTF8 -Tail 12; if ($o) { Note '--- stdout ---'; $o | ForEach-Object { Note "  $_" } } }

if (-not $p.HasExited) {
  & taskkill /PID $p.Id /T /F 2>&1 | Out-Null
}
Start-Sleep -Seconds 3
$still = New-Object System.Net.Sockets.TcpClient
try { $still.Connect('127.0.0.1', $Port); Note 'CLEANUP=PORT_STILL_OPEN'; $still.Close() } catch { Note 'CLEANUP=PORT_FREED' }
