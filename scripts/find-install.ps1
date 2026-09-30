$paths = @(
    "$env:LOCALAPPDATA\FreeMarkdown",
    "$env:LOCALAPPDATA\Programs\FreeMarkdown",
    "$env:ProgramFiles\FreeMarkdown",
    "${env:ProgramFiles(x86)}\FreeMarkdown"
)
foreach ($p in $paths) {
    if (Test-Path $p) {
        Write-Host "FOUND: $p"
        Get-ChildItem $p | Select-Object -ExpandProperty Name
    }
}

# Also check via uninstall registry
$regPaths = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
foreach ($rp in $regPaths) {
    Get-ItemProperty $rp -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like "*FreeMarkdown*" -or $_.DisplayName -like "*freemdown*" } |
        Select-Object DisplayName, InstallLocation, DisplayIcon, UninstallString
}
