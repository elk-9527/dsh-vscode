#requires -Version 7.0
param([string]$DshVersion = '0.2.1-alpha.1', [switch]$UsePackedVsix, [Parameter(Mandatory)][string]$Vsix, [Parameter(Mandatory)][string]$Tgz, [Parameter(Mandatory)][string]$Sdk)
# 在普通 PowerShell 中复测最低编辑器，不使用诊断启动标志或身份检查豁免。
$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$minimumVersion = ((Get-Content -LiteralPath (Join-Path $projectDirectory 'packages\vscode-extension\package.json') -Raw | ConvertFrom-Json).engines.vscode).TrimStart('^')
$minimumExecutable = Join-Path $projectDirectory ('build\vscode-' + $minimumVersion + '\Code.exe')
if ($env:DSH_PANEL_CODE) { $minimumExecutable = (Resolve-Path -LiteralPath $env:DSH_PANEL_CODE).Path }
if (-not (Test-Path -LiteralPath $minimumExecutable -PathType Leaf)) {
    throw ('未找到官方 VS Code ' + $minimumVersion + ' 归档；可用 DSH_PANEL_CODE 指定同版本的已安装编辑器。')
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
    $editorArguments = @('tools/bridge/test-live.cjs', $DshVersion, '--editor', '--vsix', $Vsix, '--tgz', $Tgz, '--sdk', $Sdk)
    if ($UsePackedVsix) { $editorArguments += '--packed-vsix' }
    node @editorArguments
    if ($LASTEXITCODE -ne 0) { throw '最低编辑器完整验收未通过，报告与失败记录已保留。' }
} finally {
    foreach ($name in $variableNames) {
        if ($null -eq $previousValues[$name]) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($name, $previousValues[$name], 'Process') }
    }
    Pop-Location
}
