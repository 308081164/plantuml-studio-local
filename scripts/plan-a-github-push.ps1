# Plan A: gh auth login (browser) + gh repo create and push
# Run from plantuml-desktop: .\scripts\plan-a-github-push.ps1
# Optional: set $env:GH_TOKEN='ghp_...' to skip interactive login (needs repo scope)

$ErrorActionPreference = 'Stop'
$Gh = if (Test-Path 'C:\Program Files\GitHub CLI\gh.exe') {
  'C:\Program Files\GitHub CLI\gh.exe'
} else {
  'gh'
}

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$RepoName = if ($env:GITHUB_NEW_REPO) { $env:GITHUB_NEW_REPO } else { 'plantuml-studio-local' }
$Vis = if ($env:GITHUB_REPO_VISIBILITY -eq 'private') { '--private' } else { '--public' }

Write-Host "Working dir: $Root" -ForegroundColor Cyan
Write-Host "Will create repo: $RepoName ($Vis)" -ForegroundColor Cyan

# Avoid stderr from gh breaking the run under $ErrorActionPreference = Stop
cmd /c "`"$Gh`" auth status >nul 2>&1" | Out-Null
if ($LASTEXITCODE -ne 0 -and -not $env:GH_TOKEN) {
  Write-Host ""
  Write-Host "Not logged in. Starting gh auth login (web). Open https://github.com/login/device when prompted." -ForegroundColor Yellow
  Write-Host ""
  & $Gh auth login --hostname github.com --git-protocol https --web
}

cmd /c "`"$Gh`" auth status >nul 2>&1" | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw 'gh is still not authenticated. Run: gh auth login   OR set env GH_TOKEN, then retry.'
}

Write-Host ""
Write-Host "Creating remote and pushing..." -ForegroundColor Green
& $Gh repo create $RepoName $Vis --source=. --remote=origin --push

Write-Host ""
Write-Host "Done. remote origin -> GitHub repo $RepoName" -ForegroundColor Green
