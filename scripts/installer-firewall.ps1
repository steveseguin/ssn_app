param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install", "uninstall")]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$AppPath,

  [switch]$Elevated
)

$ErrorActionPreference = "Stop"
$ruleNamePrefix = "SocialStreamNinja-"
$ruleDisplayName = "Social Stream Ninja"
$ruleGroup = "Social Stream Ninja"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NormalizedAppPath([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "The application path is required."
  }

  $fullPath = [IO.Path]::GetFullPath($value)
  if ([IO.Path]::GetExtension($fullPath) -ne ".exe") {
    throw "The application path must point to an executable."
  }

  return $fullPath
}

function Get-RuleName([string]$normalizedAppPath) {
  $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $pathBytes = [Text.Encoding]::UTF8.GetBytes($normalizedAppPath.ToUpperInvariant())
    $hashBytes = $hashAlgorithm.ComputeHash($pathBytes)
    $pathHash = [BitConverter]::ToString($hashBytes).Replace("-", "").Substring(0, 16)
    return "$ruleNamePrefix$pathHash"
  } finally {
    $hashAlgorithm.Dispose()
  }
}

function Test-MatchingRuleExists([string]$name, [string]$normalizedAppPath) {
  try {
    $rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $rule) { return $false }

    $filters = @($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
    foreach ($filter in $filters) {
      if ([string]::Equals($filter.Program, $normalizedAppPath, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    }
  } catch {
    return $false
  }

  return $false
}

function Start-ElevatedHelper([string]$normalizedAppPath) {
  if ($Elevated) {
    throw "The firewall helper did not receive administrator rights."
  }

  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $PSCommandPath),
    "-Mode", $Mode,
    "-AppPath", ('"{0}"' -f $normalizedAppPath),
    "-Elevated"
  )

  $process = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $arguments -Verb RunAs -Wait -PassThru
  exit $process.ExitCode
}

$normalizedAppPath = Get-NormalizedAppPath $AppPath
$ruleName = Get-RuleName $normalizedAppPath
$ruleExists = Test-MatchingRuleExists $ruleName $normalizedAppPath

if ($Mode -eq "install" -and $ruleExists) {
  exit 0
}

if ($Mode -eq "uninstall" -and -not $ruleExists) {
  exit 0
}

if (-not (Test-IsAdministrator)) {
  try {
    Start-ElevatedHelper $normalizedAppPath
  } catch {
    Write-Error "Administrator approval is required to update Windows Firewall: $($_.Exception.Message)"
    exit 1
  }
}

Import-Module NetSecurity -ErrorAction Stop

if ($Mode -eq "uninstall") {
  Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
  exit 0
}

if (-not (Test-Path -LiteralPath $normalizedAppPath -PathType Leaf)) {
  throw "The installed application executable was not found at $normalizedAppPath."
}

Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop

New-NetFirewallRule `
  -Name $ruleName `
  -DisplayName $ruleDisplayName `
  -Description "Allows incoming connections to the installed Social Stream Ninja app." `
  -Group $ruleGroup `
  -Direction Inbound `
  -Action Allow `
  -Program $normalizedAppPath `
  -Profile Any `
  -Protocol Any `
  -Enabled True | Out-Null
