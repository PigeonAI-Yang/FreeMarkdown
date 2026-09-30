$exePath = Join-Path $env:LOCALAPPDATA "FreeMarkdown\freemdown.exe"
if (-not (Test-Path -LiteralPath $exePath)) {
    throw "FreeMarkdown is not installed at $exePath"
}
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "FreeMarkdown.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = Split-Path $exePath
$shortcut.Description = "FreeMarkdown - Local Markdown Reader and Editor"
$shortcut.IconLocation = "$exePath,0"
$shortcut.Save()

if (Test-Path $shortcutPath) {
    Write-Host "Shortcut created: $shortcutPath"
} else {
    Write-Host "FAILED to create shortcut"
    exit 1
}
