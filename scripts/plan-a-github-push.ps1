# 方案 A：gh auth login（浏览器） + gh repo create 并推送
# 在 PowerShell 中执行： cd 到 plantuml-desktop 后运行
#   .\scripts\plan-a-github-push.ps1
# 可选：先设置 $env:GH_TOKEN='ghp_…' 可跳过交互登录（需 repo 权限）

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

Write-Host "工作目录: $Root" -ForegroundColor Cyan
Write-Host "将创建仓库: $RepoName ($Vis)" -ForegroundColor Cyan

& $Gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0 -and -not $env:GH_TOKEN) {
  Write-Host "`n尚未登录 GitHub CLI。将启动设备码/浏览器登录，请按提示在 https://github.com/login/device 完成授权。`n" -ForegroundColor Yellow
  & $Gh auth login --hostname github.com --git-protocol https --web
}

& $Gh auth status
if ($LASTEXITCODE -ne 0) {
  throw 'gh 仍未登录。请完成 gh auth login，或设置环境变量 GH_TOKEN 后重试。'
}

Write-Host "`n正在创建远程仓库并推送…" -ForegroundColor Green
& $Gh repo create $RepoName $Vis --source=. --remote=origin --push

Write-Host "`n完成。远程: origin → GitHub 仓库 $RepoName" -ForegroundColor Green
