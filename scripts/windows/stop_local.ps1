param(
    [string]$Distro = $env:FIVE9_WSL_DISTRO,
    [string]$LinuxPath = $env:FIVE9_WSL_PROJECT_PATH
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

$repoRootWin = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $LinuxPath) {
    $LinuxPath = Convert-WindowsPathToWsl -Path $repoRootWin
}

$escapedLinuxPath = Escape-BashSingleQuotes -Text $LinuxPath
$command = "cd '$escapedLinuxPath' && bash ./scripts/stop_local.sh"

$wslArgs = @()
if ($Distro) {
    $wslArgs += @("-d", $Distro)
}
$wslArgs += @("bash", "-lc", $command)

Write-Host "Deteniendo stack local dentro de WSL..."
& wsl.exe @wslArgs
exit $LASTEXITCODE
