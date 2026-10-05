#requires -Version 7.0
# 在普通 PowerShell 中复测最低编辑器，不使用诊断启动标志或身份检查豁免。
$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$minimumExecutable = Join-Path $projectDirectory 'build\vscode-1.85.2\Code.exe'
if (-not (Test-Path -LiteralPath $minimumExecutable -PathType Leaf)) {
    throw '未找到本机已保存的官方 VS Code 1.85.2 归档。'
}
if ((Get-AuthenticodeSignature -LiteralPath $minimumExecutable).Status -ne 'Valid') {
    throw '最低编辑器的文件签名未通过。'
}
$previousValues = @{}
$variableNames = @('DSH_PANEL_CODE', 'DSH_PANEL_EDITOR_NO_SANDBOX', 'DSH_PANEL_EDITOR_DISABLE_GPU', 'DSH_PANEL_EXPECT_NATIVE_RESTRICTION')
foreach ($name in $variableNames) { $previousValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
Push-Location -LiteralPath $projectDirectory
try {
    foreach ($name in $variableNames) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
    $env:DSH_PANEL_CODE = $minimumExecutable
    node tools/bridge/editor-context.cjs --code $minimumExecutable
    if ($LASTEXITCODE -ne 0) { throw '最低编辑器的进程可见范围受限或查询未完成；完整验收未开始。' }
    node tools/bridge/test-live.cjs --editor
    if ($LASTEXITCODE -ne 0) { throw '最低编辑器完整验收未通过，报告与失败记录已保留。' }
} finally {
    foreach ($name in $variableNames) {
        if ($null -eq $previousValues[$name]) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($name, $previousValues[$name], 'Process') }
    }
    Pop-Location
}
