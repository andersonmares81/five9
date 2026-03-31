param(
    [string]$Distro = $env:FIVE9_WSL_DISTRO,
    [string]$LinuxPath = $env:FIVE9_WSL_PROJECT_PATH,
    [string]$XamppRoot = $(if ($env:FIVE9_XAMPP_ROOT) { $env:FIVE9_XAMPP_ROOT } else { "C:\xampp" })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Convert-WindowsPathToWsl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $normalized = $Path -replace "\\", "/"
    if ($normalized -match "^([A-Za-z]):/(.*)$") {
        $drive = $Matches[1].ToLowerInvariant()
        $rest = $Matches[2]
        return "/mnt/$drive/$rest"
    }

    throw "No se pudo convertir la ruta Windows a WSL: $Path. Define FIVE9_WSL_PROJECT_PATH manualmente."
}

function Escape-BashSingleQuotes {
    param([Parameter(Mandatory = $true)][string]$Text)
    return $Text.Replace("'", "'""'""'")
}

function Write-Check {
    param(
        [string]$Name,
        [bool]$Ok,
        [string]$Detail
    )

    $status = if ($Ok) { "ok" } else { "missing" }
    Write-Host "$Name=$status $Detail"
}

$repoRootWin = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $LinuxPath) {
    $LinuxPath = Convert-WindowsPathToWsl -Path $repoRootWin
}

$wslList = & wsl.exe -l -q 2>$null
$hasWsl = $LASTEXITCODE -eq 0 -and $wslList
Write-Check -Name "wsl" -Ok ([bool]$hasWsl) -Detail ""

$wslArgs = @()
if ($Distro) {
    $wslArgs += @("-d", $Distro)
}

$escapedLinuxPath = Escape-BashSingleQuotes -Text $LinuxPath

$checks = @(
    @{ Name = "repo"; Command = "test -d '$escapedLinuxPath'" },
    @{ Name = "node"; Command = "command -v node >/dev/null 2>&1" },
    @{ Name = "npm"; Command = "command -v npm >/dev/null 2>&1" },
    @{ Name = "python"; Command = "command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1" },
    @{ Name = "ffmpeg"; Command = "command -v ffmpeg >/dev/null 2>&1" },
    @{ Name = "psql"; Command = "command -v psql >/dev/null 2>&1" }
)

foreach ($check in $checks) {
    & wsl.exe @wslArgs bash -lc $check.Command | Out-Null
    Write-Check -Name $check.Name -Ok ($LASTEXITCODE -eq 0) -Detail ""
}

Write-Check -Name "xampp_httpd" -Ok (Test-Path (Join-Path $XamppRoot "apache\bin\httpd.exe")) -Detail $XamppRoot
Write-Check -Name "xampp_php" -Ok (Test-Path (Join-Path $XamppRoot "php\php.exe")) -Detail $XamppRoot
Write-Check -Name "web_env" -Ok (Test-Path (Join-Path $repoRootWin "web\.env")) -Detail "optional but recommended"
Write-Check -Name "backup_php_env" -Ok (Test-Path (Join-Path $repoRootWin "backup-php\.env")) -Detail "required for backup ingest"

Write-Host "wsl_project_path=$LinuxPath"
Write-Host "xampp_root=$XamppRoot"
