import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const appName = env.ELECTROBUN_APP_NAME || "JiraSyncHub";
const buildEnv = env.ELECTROBUN_BUILD_ENV || "stable";
const targetOs = env.ELECTROBUN_OS || process.platform;
const targetArch = env.ELECTROBUN_ARCH || process.arch;
const artifactDir = env.ELECTROBUN_ARTIFACT_DIR;

if (!artifactDir) {
  throw new Error("ELECTROBUN_ARTIFACT_DIR is required for postPackage");
}

mkdirSync(artifactDir, { recursive: true });

const safeAppName = appName.replace(/\s+/g, "");
const dataDirName = safeAppName;
const platformPrefix = `${buildEnv}-${targetOs}-${targetArch}`;

function writeTextArtifact(filename, content, executable = false) {
  const fullPath = join(artifactDir, `${platformPrefix}-${filename}`);
  writeFileSync(fullPath, content, "utf8");
  if (executable && targetOs !== "win") {
    chmodSync(fullPath, 0o755);
  }
  console.log(`Created uninstall helper: ${fullPath}`);
}

function buildWindowsUninstallPs1() {
  return `Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$appName = "${appName}"
$safeAppName = "${safeAppName}"
$dataDir = Join-Path $env:APPDATA "${dataDirName}"
$shortcutCandidates = @(
  Join-Path ([Environment]::GetFolderPath("Desktop")) "$appName.lnk",
  Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\$appName.lnk"
)

function Get-InstallDirFromShortcut([string]$shortcutPath) {
  if (-not (Test-Path $shortcutPath)) {
    return $null
  }

  $wsh = New-Object -ComObject WScript.Shell
  $shortcut = $wsh.CreateShortcut($shortcutPath)
  if (-not $shortcut.TargetPath) {
    return $null
  }

  if ((Split-Path $shortcut.TargetPath -Leaf) -ine "launcher.exe") {
    return $null
  }

  $binDir = Split-Path $shortcut.TargetPath -Parent
  $installDir = Split-Path $binDir -Parent
  if (Test-Path (Join-Path $installDir "bin\\launcher.exe")) {
    return $installDir
  }

  return $null
}

function Get-InstallDirFromCommonLocations {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA $safeAppName),
    (Join-Path $env:LOCALAPPDATA $appName),
    (Join-Path $env:APPDATA $safeAppName),
    (Join-Path $env:APPDATA $appName)
  )

  foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate "bin\\launcher.exe")) {
      return $candidate
    }
  }

  return $null
}

$installDir = $null
foreach ($shortcutPath in $shortcutCandidates) {
  $resolved = Get-InstallDirFromShortcut $shortcutPath
  if ($resolved) {
    $installDir = $resolved
    break
  }
}

if (-not $installDir) {
  $installDir = Get-InstallDirFromCommonLocations
}

if ($installDir -and (Test-Path $installDir)) {
  Write-Host "Removing install directory: $installDir"
  Remove-Item $installDir -Recurse -Force
} else {
  Write-Warning "Could not automatically locate the install directory for $appName."
}

foreach ($shortcutPath in $shortcutCandidates) {
  if (Test-Path $shortcutPath) {
    Write-Host "Removing shortcut: $shortcutPath"
    Remove-Item $shortcutPath -Force
  }
}

$uninstallRoot = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
if (Test-Path $uninstallRoot) {
  Get-ChildItem $uninstallRoot | ForEach-Object {
    $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $props) {
      return
    }

    $displayName = [string]$props.DisplayName
    $installLocation = [string]$props.InstallLocation
    if ($displayName -eq $appName -or ($installDir -and $installLocation -eq $installDir)) {
      Write-Host "Removing uninstall registry entry: $($_.PSChildName)"
      Remove-Item $_.PSPath -Recurse -Force
    }
  }
}

if (Test-Path $dataDir) {
  Write-Host "Removing app data: $dataDir"
  Remove-Item $dataDir -Recurse -Force
}

Write-Host "$appName uninstall complete."
`;
}

function buildWindowsUninstallCmd() {
  return `@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0${safeAppName}-uninstall.ps1"
`;
}

function buildMacUninstallCommand() {
  return `#!/bin/bash
set -euo pipefail

APP_NAME="${appName}"
DATA_DIR="$HOME/.jirasync-hub"

for candidate in "/Applications/${appName}.app" "$HOME/Applications/${appName}.app"; do
  if [ -e "$candidate" ]; then
    echo "Removing $candidate"
    rm -rf "$candidate"
  fi
done

if [ -d "$DATA_DIR" ]; then
  echo "Removing $DATA_DIR"
  rm -rf "$DATA_DIR"
fi

echo "$APP_NAME uninstall complete."
`;
}

function buildLinuxUninstallScript() {
  return `#!/bin/bash
set -euo pipefail

APP_NAME="${appName}"
SAFE_APP_NAME="${safeAppName}"
DATA_DIR="$HOME/.jirasync-hub"

for candidate in "$HOME/.local/share/$SAFE_APP_NAME" "$HOME/.local/share/$APP_NAME"; do
  if [ -e "$candidate" ]; then
    echo "Removing $candidate"
    rm -rf "$candidate"
  fi
done

for desktop_dir in "$HOME/.local/share/applications" "$HOME/Desktop"; do
  if [ -d "$desktop_dir" ]; then
    while IFS= read -r -d '' file; do
      if grep -q "Name=$APP_NAME" "$file" || grep -q "StartupWMClass=$APP_NAME" "$file"; then
        echo "Removing $file"
        rm -f "$file"
      fi
    done < <(find "$desktop_dir" -maxdepth 1 -type f -name '*.desktop' -print0)
  fi
done

if [ -d "$DATA_DIR" ]; then
  echo "Removing $DATA_DIR"
  rm -rf "$DATA_DIR"
fi

echo "$APP_NAME uninstall complete."
`;
}

if (targetOs === "win") {
  writeTextArtifact(`${safeAppName}-uninstall.ps1`, buildWindowsUninstallPs1());
  writeTextArtifact(`${safeAppName}-uninstall.cmd`, buildWindowsUninstallCmd());
} else if (targetOs === "macos") {
  writeTextArtifact(`${safeAppName}-uninstall.command`, buildMacUninstallCommand(), true);
} else if (targetOs === "linux") {
  writeTextArtifact(`${safeAppName}-uninstall.sh`, buildLinuxUninstallScript(), true);
}
