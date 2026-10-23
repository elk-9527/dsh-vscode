'use strict';
/** 官方编辑器夹具只校正生成目录中已知签名映像的 MIC，不修改目录 DACL。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT } = require('../compat/lib.cjs');

const IMAGES = Object.freeze(['Code.exe', 'ffmpeg.dll', 'd3dcompiler_47.dll', 'libEGL.dll',
  'libGLESv2.dll', 'vk_swiftshader.dll', 'vulkan-1.dll']);
function inside(file, root) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function fixtureImages(code, root = ROOT) {
  const build = fs.realpathSync(path.join(root, 'build'));
  const actual = fs.realpathSync(code);
  if (!inside(actual, build) || path.basename(actual).toLowerCase() !== 'code.exe') throw new Error('编辑器夹具必须是本项目 build 内的 Code.exe');
  const folder = path.dirname(actual);
  return IMAGES.map(name => path.join(folder, name)).filter(file => fs.existsSync(file)).map(file => {
    const resolved = fs.realpathSync(file), stat = fs.statSync(file);
    if (path.dirname(resolved) !== folder || !stat.isFile() || stat.nlink !== 1) throw new Error('编辑器夹具映像不能链接到其他位置');
    return resolved;
  });
}
function isBuildEditor(code, root = ROOT) {
  try { return inside(fs.realpathSync(code), fs.realpathSync(path.join(root, 'build')))
    && path.basename(code).toLowerCase() === 'code.exe'; } catch { return false; }
}
const quote = text => `'${text.replace(/'/g, "''")}'`;
function prepareEditorFixture({ code, reportFile, root = ROOT, platform = process.platform, run = execFileSync }) {
  if (platform !== 'win32') return { status: 'not-applicable', reason: 'Windows MIC only' };
  const files = fixtureImages(code, root);
  const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class EditorFixtureLabel {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfo(string file,int kind,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor,uint revision,uint info,out IntPtr value,out uint length);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 public static string Read(string file) {IntPtr sd;uint error=GetNamedSecurityInfo(file,1,16,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out sd);if(error!=0)throw new Exception("Read image label: "+error);try{IntPtr value;uint length;if(!ConvertSecurityDescriptorToStringSecurityDescriptor(sd,1,16,out value,out length))throw new Exception("Format image label: "+Marshal.GetLastWin32Error());try{return Marshal.PtrToStringUni(value);}finally{LocalFree(value);}}finally{LocalFree(sd);}}
}
'@
$verified=@()
foreach($file in @(${files.map(quote).join(',')})) {
 $signature=Get-AuthenticodeSignature -LiteralPath $file
 if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )CN=Microsoft Corporation(,|$)'){throw ('官方编辑器映像签名未通过: '+[IO.Path]::GetFileName($file))}
 $sha=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
 $dacl=(Get-Acl -LiteralPath $file).Sddl
 $label=[EditorFixtureLabel]::Read($file)
 $normalized=$label -match ';;;LW\\)'
 if(!$normalized -and $label -notin @('','S:') -and $label -notmatch ';;;ME\\)'){throw ('编辑器夹具映像标签不是普通 Medium: '+$label)}
 $verified+=@{file=$file;signature=$signature;sha=$sha;dacl=$dacl;label=$label;normalized=$normalized}
}
$results=@()
foreach($item in $verified) {
 $file=$item.file; $signature=$item.signature; $sha=$item.sha; $dacl=$item.dacl; $label=$item.label; $normalized=$item.normalized
 if($normalized) { & (Join-Path $env:SystemRoot 'System32/icacls.exe') $file /setintegritylevel M | Out-Null; if($LASTEXITCODE -ne 0){throw '编辑器夹具映像标签校正失败'} }
 $afterLabel=[EditorFixtureLabel]::Read($file)
 $afterSha=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
 $afterDacl=(Get-Acl -LiteralPath $file).Sddl
 $afterSignature=Get-AuthenticodeSignature -LiteralPath $file
 if($afterSha -ne $sha -or $afterDacl -ne $dacl -or $afterSignature.Status -ne 'Valid' -or ($afterLabel -notin @('','S:') -and $afterLabel -notmatch ';;;ME\\)')){throw '编辑器夹具映像内容、签名、DACL 或标签校验不一致'}
 $results+=@{name=[IO.Path]::GetFileName($file);sha256=$sha;sha256After=$afterSha;signature=[string]$signature.Status;signatureAfter=[string]$afterSignature.Status;signer=$signature.SignerCertificate.Subject;dacl=$dacl;daclAfter=$afterDacl;labelBefore=$label;labelAfter=$afterLabel;normalized=$normalized;sha256Unchanged=$true;daclUnchanged=$true}
}
ConvertTo-Json -InputObject @($results) -Depth 4 -Compress`;
  const env = { ...process.env };
  // Windows PowerShell 必须使用自己的内置安全模块，不能继承 PowerShell 7 的模块路径。
  for (const key of Object.keys(env)) if (/^PSModulePath$/i.test(key)) delete env[key];
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const records = JSON.parse(run(shell, ['-NoProfile', '-NonInteractive', '-Command', script],
    { env, encoding: 'utf8', windowsHide: true, timeout: 30000 }));
  if (!Array.isArray(records) || records.length !== files.length || records.some((item, index) => item.name !== path.basename(files[index])
    || !/^[a-f0-9]{64}$/.test(item.sha256) || item.sha256After !== item.sha256 || item.signature !== 'Valid' || item.signatureAfter !== 'Valid'
    || typeof item.dacl !== 'string' || item.daclAfter !== item.dacl || typeof item.normalized !== 'boolean'
    || item.sha256Unchanged !== true || item.daclUnchanged !== true)) {
    throw new Error('编辑器夹具映像准备结果不完整');
  }
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify({ status: 'passed', files: records }, null, 2) + '\n', { flag: 'wx' });
  return { status: 'passed', checked: records.length, normalized: records.filter(item => item.normalized).length };
}
module.exports = { IMAGES, fixtureImages, isBuildEditor, prepareEditorFixture };
