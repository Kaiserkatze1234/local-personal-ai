<#
.SYNOPSIS
  Removes the self-hosted runner installed by install-runner.ps1 (task/service,
  registration at GitHub, binaries, work directory).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\remove-runner.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Repo = 'Kaiserkatze1234/local-personal-ai',
  [string]$RunnerName = "$env:COMPUTERNAME-lpai",
  [string]$RunnerDir = 'C:\actions-runner-lpai',
  [string]$Token,
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Continue'
function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

Say '== Stopping autostart' 'Cyan'
if (Get-ScheduledTask -TaskName 'LPAI GitHub Runner' -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName 'LPAI GitHub Runner' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'LPAI GitHub Runner' -Confirm:$false
  Say '  scheduled task removed' 'Green'
}
$serviceName = "actions.runner.$($Repo -replace '/', '-').$RunnerName"
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  & "$RunnerDir\svc.cmd" stop | Out-Null
  & "$RunnerDir\svc.cmd" uninstall | Out-Null
  Say '  service removed' 'Green'
}

Say '== Deregistering at GitHub' 'Cyan'
if (-not $Token) {
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    $Token = (& gh api -X POST "repos/$Repo/actions/runners/remove-token" --jq .token 2>$null)
  }
  elseif ($env:GH_TOKEN) {
    $resp = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/actions/runners/remove-token" `
      -Headers @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'lpai-runner-setup' }
    $Token = $resp.token
  }
}
if ($Token -and (Test-Path (Join-Path $RunnerDir 'config.cmd'))) {
  & "$RunnerDir\config.cmd" remove --token $Token
  Say '  runner deregistered' 'Green'
}
else {
  Say '  no removal token -- delete the runner manually: Settings -> Actions -> Runners' 'Yellow'
}

if (-not $KeepFiles) {
  Say '== Deleting files' 'Cyan'
  Remove-Item -LiteralPath $RunnerDir -Recurse -Force -ErrorAction SilentlyContinue
  Say "  $RunnerDir deleted" 'Green'
}
Say 'Done. No test infrastructure is left running on this PC.' 'Green'
