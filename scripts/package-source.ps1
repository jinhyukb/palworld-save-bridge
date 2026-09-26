$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$workspace = Split-Path -Parent $project
$release = Join-Path $workspace 'release'
$stage = Join-Path (Join-Path $workspace 'work') ('source-package-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$name = 'Palworld-Save-Bridge-0.1.0-Source'
$target = Join-Path $stage $name
$resolvedWorkspace = [IO.Path]::GetFullPath($workspace)
$resolvedStage = [IO.Path]::GetFullPath($stage)
if (-not $resolvedStage.StartsWith(($resolvedWorkspace.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Source staging path is outside the intended workspace.' }
New-Item -ItemType Directory -Path $target, $release -Force | Out-Null
foreach ($folder in @('src', 'assets', 'vendor', 'docs', 'scripts', 'tests')) {
    Copy-Item -LiteralPath (Join-Path $project $folder) -Destination $target -Recurse
}
foreach ($file in @('package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'eslint.config.mjs', '.gitignore', '.prettierignore')) {
    Copy-Item -LiteralPath (Join-Path $project $file) -Destination $target
}
$archive = Join-Path $release ($name + '.zip')
Compress-Archive -LiteralPath $target -DestinationPath $archive -CompressionLevel Optimal -Force
Add-Type -AssemblyName System.IO.Compression
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $names = @($zip.Entries | ForEach-Object FullName)
    if ($names.Count -eq 0 -or $names | Where-Object { $_ -match '(^|/)(node_modules|backups|results|work)/|\.sav$|\.exe$' }) { throw 'Source archive includes generated or private files.' }
} finally { $zip.Dispose() }
Write-Output "Source archive: $archive"
