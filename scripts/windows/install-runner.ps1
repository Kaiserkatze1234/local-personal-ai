<#
.SYNOPSIS
  One-time setup of the GitHub Actions self-hosted runner that executes the real
  Windows/Electron/Ollama test loop on this PC.

.DESCRIPTION
  After this script has run once, `npm run test:autonomous` is started by GitHub
  on every push to main / arena/* -- no clicking, no copying, no manual test run.

  What it does:
    1. checks the toolchain this repo needs (Node 22+, npm, git, disk, optional Ollama),
    2. downloads the official GitHub runner into $RunnerDir (outside the repo),
    3. registers it against the repository with the labels the workflow asks for,
    4. makes it start automatically:
         -Mode Task    (default) -- scheduled task at user logon -> runs in the
                       INTERACTIVE session, which is what the real Electron GUI
                       tests need (screenshots, window, renderer).
         -Mode Service            -- runs as a Windows service (Session 0). Works
                       for headless stages, but GUI/E2E stages are unreliable in
                       Session 0; use only if you accept that.
    5. starts it and verifies that GitHub sees the runner as online.

  Security: the runner only accepts jobs from the workflows of THIS repository.
  The repository's workflows never use `pull_request` triggers for self-hosted
  jobs (see .github/workflows/autonomous-test.yml), so code from a fork cannot
  reach this machine. Labels are unique to this runner so no other workflow that
  might be added later can accidentally target it without naming them.

.EXAMPLE
  # recommended (interactive session, no admin rights needed)
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-runner.ps1

.EXAMPLE
  # with an explicit registration token instead of the gh CLI
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-runner.ps1 -Token ghs_xxx
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Repo = 'Kaiserkatze1234/local-personal-ai',
  [string]$RunnerName = "$env:COMPUTERNAME-lpai",
  [string]$RunnerDir = 'C:\actions-runner-lpai',
  [string]$Labels = 'lpai-test',
  [string]$Token,
  [string]$RunnerVersion,
  [ValidateSet('Task', 'Service')][string]$Mode = 'Task',
  [switch]$Replace,
  [switch]$SkipToolchainCheck,
  # re-download the runner zip even when config.cmd is already there
  [switch]$ForceDownload
)

$ErrorActionPreference = 'Stop'
function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Step($msg) { Say "`n== $msg" 'Cyan' }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# ------------------------------------------------------------------ 1. checks
if (-not $SkipToolchainCheck) {
  Step 'Toolchain check'
  $problems = @()
  $warnings = @()

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { $problems += 'Node.js not found on PATH -- install Node 22 LTS (https://nodejs.org) and re-run.' }
  else {
    $nodeVersion = (& node -v).TrimStart('v')
    $major = [int]($nodeVersion.Split('.')[0])
    if ($major -lt 22) { $problems += "Node $nodeVersion is too old -- package.json requires >= 22." } else { Say "  node $nodeVersion" 'Green' }
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $problems += 'npm not found on PATH.' }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $warnings += 'git not found on PATH -- the runner itself brings its own git for checkout, but local debugging is easier with it.' }

  $ollamaExe = Get-Command ollama -ErrorAction SilentlyContinue
  if (-not $ollamaExe) { $warnings += 'ollama not on PATH -- the runtime stage will report SKIP (never a pass). Install Ollama and pull a chat model for full coverage.' }
  else {
    $installed = (& ollama list) 2>$null | Select-Object -Skip 1 | Where-Object { $_.Trim() -ne '' }
    if (-not $installed) { $warnings += 'Ollama is installed but no model is pulled (try: ollama pull qwen2.5-coder:7b).' } else { Say "  ollama models: $($installed.Count)" 'Green' }
  }

  # the runner dir usually does not exist yet on a first run -- read the drive
  # letter from the configured path, never from Resolve-Path's .Path (that is a
  # string for the fallback and .Substring would throw under $ErrorActionPreference='Stop')
  $driveLetter = if ($RunnerDir -match '^([A-Za-z]):') { $Matches[1].ToUpper() } else { 'C' }
  $drive = Get-PSDrive -PSProvider FileSystem -Name $driveLetter -ErrorAction SilentlyContinue
  if ($drive) {
    $freeGb = [math]::Round($drive.Free / 1GB, 1)
    if ($freeGb -lt 6) { $warnings += "only $freeGb GB free on $($driveLetter): -- runner work dirs + npm ci + Electron need room." }
    else { Say "  free disk: $freeGb GB on $($driveLetter):" 'Green' }
  }
  else { Say "  free disk: could not read $($driveLetter): (skipped)" 'Yellow' }

  foreach ($w in $warnings) { Say "  ! $w" 'Yellow' }
  if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Say "  x $p" 'Red' }
    throw 'Toolchain check failed -- fix the items above (or pass -SkipToolchainCheck).'
  }
  Say '  toolchain OK' 'Green'
}

if ($Mode -eq 'Service' -and -not $isAdmin) { throw "-Mode Service needs an elevated (Administrator) PowerShell." }

# ------------------------------------------------- 2. resolve runner version
Step "Preparing runner directory $RunnerDir"
if (-not (Test-Path $RunnerDir)) { New-Item -ItemType Directory -Path $RunnerDir | Out-Null }
Push-Location $RunnerDir
try {
  if (-not $RunnerVersion) {
    Say '  looking up the newest runner release...'
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{ 'User-Agent' = 'lpai-runner-setup' }
    $RunnerVersion = ($release.tag_name -replace '^v', '')
  }
  $zipName = "actions-runner-win-x64-$RunnerVersion.zip"
  $zipPath = Join-Path $RunnerDir $zipName
  $needDownload = $ForceDownload.IsPresent -or -not (Test-Path (Join-Path $RunnerDir 'config.cmd'))
  if ($needDownload) {
    if (-not (Test-Path $zipPath)) {
      Say "  downloading $zipName"
      Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v$RunnerVersion/$zipName" -OutFile $zipPath -UseBasicParsing
    }
    Say '  extracting...'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $RunnerDir -Force
  }
  else { Say '  runner binaries already present' }

  # ------------------------------------------------- 3. registration token
  Step 'Registration token'
  if (-not $Token) {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
      Say '  asking the gh CLI...'
      $Token = (& gh api -X POST "repos/$Repo/actions/runners/registration-token" --jq .token 2>$null)
    }
    if (-not $Token -and $env:GH_TOKEN) {
      Say '  asking the GitHub API with $env:GH_TOKEN...'
      $resp = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/actions/runners/registration-token" `
        -Headers @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'lpai-runner-setup' }
      $Token = $resp.token
    }
    if (-not $Token) {
      Say '  Could not obtain a token automatically.' 'Yellow'
      Say '  Either install + login the gh CLI (`gh auth login`), set $env:GH_TOKEN, or paste a token:' 'Yellow'
      Say '  GitHub -> repo -> Settings -> Actions -> Runners -> New self-hosted runner (the token is valid ~1 hour).' 'Yellow'
      $Token = (Read-Host '  Registration token').Trim()
      if (-not $Token) { throw 'No registration token provided.' }
    }
  }

  # ------------------------------------------------- 4. register
  Step 'Registering the runner'
  $configArgs = @('--url', "https://github.com/$Repo", '--token', $Token, '--name', $RunnerName, '--labels', $Labels, '--work', '_work', '--unattended')
  if ($Replace) { $configArgs += '--replace' }
  & "$RunnerDir\config.cmd" @configArgs
  if ($LASTEXITCODE -ne 0) { throw "config.cmd failed with exit code $LASTEXITCODE" }

  # ------------------------------------------------- 5. autostart
  Step "Autostart ($Mode)"
  if ($Mode -eq 'Task') {
    $taskName = 'LPAI GitHub Runner'
    $action = New-ScheduledTaskAction -Execute "$RunnerDir\run.cmd" -WorkingDirectory $RunnerDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    try {
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force `
        -Description 'GitHub Actions self-hosted runner for local-personal-ai (autonomous Windows test loop)' | Out-Null
    }
    catch {
      throw "Register-ScheduledTask failed ($($_.Exception.Message)). Re-run this script from an elevated PowerShell, or use -Mode Service from an elevated shell."
    }
    Say "  scheduled task '$taskName' created (starts at every logon, restarts on failure)"
    Start-ScheduledTask -TaskName $taskName
    Say '  task started'
    Say '  note: auto-login is not required for the tests to work, but the runner only exists while you are logged in.' 'Yellow'
  }
  else {
    & "$RunnerDir\svc.cmd" install
    & "$RunnerDir\svc.cmd" start
    $serviceName = "actions.runner.$($Repo -replace '/', '-').$RunnerName"
    sc.exe failure $serviceName reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
    Say "  service '$serviceName' installed, started, with automatic restart" 'Green'
    Say '  caveat: a service runs in Session 0 -- the GUI/Electron E2E stages may not be able to open a window there.' 'Yellow'
    Say '  If E2E reports INFRASTRUCTURE_ERROR, re-run this script with -Mode Task.' 'Yellow'
  }

  # ------------------------------------------------- 6. verify
  Step 'Verification'
  Start-Sleep -Seconds 8
  $ghCmd = Get-Command gh -ErrorAction SilentlyContinue
  if ($ghCmd) {
    try {
      $runners = (& gh api "repos/$Repo/actions/runners" --jq ".runners[] | select(.name==\"$RunnerName\") | \"\(.status) \(.labels | map(.name) | join(\",\"))\"" 2>$null)
      if ($runners) { Say "  GitHub reports: $runners" 'Green' }
      else { Say '  the runner is not listed yet -- check the Actions -> Runners page in a minute.' 'Yellow' }
    }
    catch { Say "  verification via gh failed: $($_.Exception.Message)" 'Yellow' }
  }
  else {
    Say "  check https://github.com/$Repo/settings/actions/runners -- '$RunnerName' should be online." 'Yellow'
  }

  Say "`nDone. The loop is live:" 'Green'
  Say "  push to main / arena/* -> this PC runs npm run test:autonomous -> report lands as a PR comment + artifact." 'Green'
  Say "  To remove everything: scripts\windows\remove-runner.ps1" 'Gray'
}
finally { Pop-Location }
