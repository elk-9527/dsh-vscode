param([string[]]$Repos, [string]$OutDir = "D:\dsh-vscode\_research\repos")

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$hdr = @{ 'User-Agent' = 'dsh-research'; 'Accept' = 'application/vnd.github+json' }

foreach ($spec in $Repos) {
  # spec format: owner/repo  or  owner/repo::subdir  or  owner/repo::subdir@branch
  $parts = $spec -split '::'
  $repo = $parts[0]
  $sub = $null; $branch = $null
  if ($parts.Count -gt 1) {
    $s = $parts[1]
    if ($s -match '@') { $sub, $branch = $s -split '@'; $branch = $branch.TrimStart('/') } else { $sub = $s }
  }
  $safe = (($repo + '-' + $sub) -replace '[\\/:@]', '_')
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("### REPO: $repo  SUBDIR: $sub  BRANCH: $branch")

  # repo metadata
  try {
    $meta = (Invoke-WebRequest -Uri "https://api.github.com/repos/$repo" -Headers $hdr -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json
    $lines.Add("META default_branch=$($meta.default_branch) stars=$($meta.stargazers_count) forks=$($meta.forks_count) pushed_at=$($meta.pushed_at) created_at=$($meta.created_at) license=$($meta.license.spdx_id) archived=$($meta.archived) open_issues=$($meta.open_issues_count) homepage=$($meta.homepage)")
    $lines.Add("META description=$($meta.description)")
    if (-not $branch) { $branch = $meta.default_branch }
  } catch { $lines.Add("META ERROR: $($_.Exception.Message)") }

  # latest release
  try {
    $rel = (Invoke-WebRequest -Uri "https://api.github.com/repos/$repo/releases?per_page=3" -Headers $hdr -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json
    if ($rel.Count -gt 0) {
      foreach ($r in $rel) { $lines.Add("RELEASE $($r.tag_name) published=$($r.published_at) prerelease=$($r.prerelease) assets=$($r.assets.Count)") }
    } else { $lines.Add("RELEASE none") }
  } catch { $lines.Add("RELEASE ERROR: $($_.Exception.Message)") }

  # latest commits
  try {
    $cm = (Invoke-WebRequest -Uri "https://api.github.com/repos/$repo/commits?per_page=3" -Headers $hdr -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json
    foreach ($c in $cm) { $lines.Add("COMMIT $($c.sha.Substring(0,7)) $($c.commit.author.date) :: $(($c.commit.message -split "`n")[0])") }
  } catch { $lines.Add("COMMIT ERROR: $($_.Exception.Message)") }

  # file tree (root + subdir) to find data paths / docs
  try {
    $tree = (Invoke-WebRequest -Uri "https://api.github.com/repos/$repo/git/trees/$branch`?recursive=1" -Headers $hdr -UseBasicParsing -TimeoutSec 40).Content | ConvertFrom-Json
    $paths = $tree.tree | Where-Object { $_.type -eq 'blob' } | Select-Object -ExpandProperty path
    $lines.Add("TREE FILECOUNT=$($paths.Count)")
    if ($sub) { $scope = $paths | Where-Object { $_ -like "$sub/*" } } else { $scope = $paths }
    $lines.Add("--- FILES IN SCOPE (max 120) ---")
    $scope | Select-Object -First 120 | ForEach-Object { $lines.Add("F $_") }
  } catch { $lines.Add("TREE ERROR: $($_.Exception.Message)") }

  # README candidates
  $base = "https://raw.githubusercontent.com/$repo/$branch"
  $cands = New-Object System.Collections.Generic.List[string]
  if ($sub) {
    foreach ($n in @('README.md','readme.md','README.zh-CN.md','README_EN.md','README.zh.md')) { $cands.Add("$base/$sub/$n") }
  }
  foreach ($n in @('README.md','readme.md','README.zh-CN.md','README_EN.md','README.zh.md')) { $cands.Add("$base/$n") }
  $got = $false
  foreach ($c in $cands) {
    try {
      $r = Invoke-WebRequest -Uri $c -UseBasicParsing -TimeoutSec 30
      if ($r.StatusCode -eq 200 -and $r.Content.Length -gt 200) {
        $lines.Add("=== README FROM: $c (len=$($r.Content.Length)) ===")
        $lines.Add($r.Content)
        $got = $true
        break
      }
    } catch { }
  }
  if (-not $got) { $lines.Add("=== README NOT FOUND via raw; tried $($cands.Count) candidates ===") }

  $lines -join "`n" | Out-File -Encoding utf8 "$OutDir\$safe.md"
  Write-Output "OK $safe ($((($lines -join "`n").Length)) chars)"
}
