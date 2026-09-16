param([string[]]$Repos, [string]$OutDir = "D:\dsh-vscode\_research\repos2", [switch]$SkipApi)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$hdr = @{ 'User-Agent' = 'Mozilla/5.0 dsh-research'; 'Accept' = 'application/vnd.github+json' }

function Try-Web([string]$url) {
  try { return (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30 -Headers @{ 'User-Agent' = 'Mozilla/5.0 dsh-research' }) } catch { return $null }
}

foreach ($spec in $Repos) {
  $parts = $spec -split '::'
  $repo = $parts[0]
  $sub = $null; $branch = $null
  if ($parts.Count -gt 1) {
    $s = $parts[1]
    if ($s -match '@') { $sub, $branch = $s -split '@'; $branch = $branch.TrimStart('/') } else { $sub = $s }
  }
  $safe = (($repo + '-' + $sub) -replace '[\\/:@]', '_')
  $L = New-Object System.Collections.Generic.List[string]
  $L.Add("### REPO: $repo  SUBDIR: $sub  BRANCH: $branch")

  $branches = @()
  if ($branch) { $branches += $branch }
  $branches += @('main','master')
  $branches = $branches | Select-Object -Unique

  # repo metadata via API (best effort, rate-limited)
  if (-not $SkipApi) {
    $r = Try-Web "https://api.github.com/repos/$repo"
    if ($r) {
      $meta = $r.Content | ConvertFrom-Json
      $L.Add("META default_branch=$($meta.default_branch) stars=$($meta.stargazers_count) forks=$($meta.forks_count) pushed_at=$($meta.pushed_at) created_at=$($meta.created_at) license=$($meta.license.spdx_id) archived=$($meta.archived) open_issues=$($meta.open_issues_count) homepage=$($meta.homepage)")
      $L.Add("META description=$($meta.description)")
      if (-not $branch) { $branch = $meta.default_branch; $branches = @($branch) + $branches | Select-Object -Unique }
    } else { $L.Add("META unavailable (403/ratelimit or missing)") }
    $rel = Try-Web "https://api.github.com/repos/$repo/releases?per_page=3"
    if ($rel) {
      $rl = $rel.Content | ConvertFrom-Json
      if ($rl.Count -gt 0) { foreach ($x in $rl) { $L.Add("RELEASE $($x.tag_name) published=$($x.published_at) prerelease=$($x.prerelease)") } } else { $L.Add("RELEASE none") }
    }
  }

  # commits via Atom feed (no API / no rate limit)
  foreach ($b in $branches) {
    $a = Try-Web "https://github.com/$repo/commits/$b.atom"
    if ($a -and $a.Content -match '<entry>') {
      $L.Add("ATOM OK branch=$b")
      $doc = [xml]$a.Content
      $n = 0
      foreach ($e in $doc.feed.entry) {
        if ($n -ge 5) { break }
        $L.Add("COMMIT $($e.updated) :: $((($e.title -replace '\s+',' ').Trim()))")
        $n++
      }
      if (-not $branch) { $branch = $b }
      break
    } else { $L.Add("ATOM MISS branch=$b") }
  }

  # README
  $cands = New-Object System.Collections.Generic.List[string]
  foreach ($b in $branches) {
    $base = "https://raw.githubusercontent.com/$repo/$b"
    if ($sub) { foreach ($n in @('README.md','readme.md','README_EN.md','README.en.md','README.zh.md')) { $cands.Add("$base/$sub/$n") } }
    foreach ($n in @('README.md','readme.md','README_EN.md','README.en.md','README.zh.md')) { $cands.Add("$base/$n") }
  }
  $got = $false
  foreach ($c in $cands) {
    $r = Try-Web $c
    if ($r -and $r.StatusCode -eq 200 -and $r.Content.Length -gt 300) {
      $L.Add("=== README FROM: $c (len=$($r.Content.Length)) ===")
      $L.Add($r.Content)
      $got = $true
      break
    }
  }
  if (-not $got) { $L.Add("=== README NOT FOUND ($($cands.Count) candidates tried) ===") }

  $L -join "`n" | Out-File -Encoding utf8 "$OutDir\$safe.md"
  Write-Output "OK $safe ($((($L -join "`n").Length)) chars)"
}
