$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw (Join-Path $root "manifest.json") | ConvertFrom-Json
$version = $manifest.version
$outDir = Join-Path $root "dist"
$xpi = Join-Path $outDir "local-page-summarizer-$version.xpi"

$entries = @(
  @{ Source = "manifest.json"; Entry = "manifest.json" },
  @{ Source = "popup.html"; Entry = "popup.html" },
  @{ Source = "popup.css"; Entry = "popup.css" },
  @{ Source = "popup.js"; Entry = "popup.js" },
  @{ Source = "contentScript.js"; Entry = "contentScript.js" },
  @{ Source = "background.js"; Entry = "background.js" },
  @{ Source = "README.md"; Entry = "README.md" },
  @{ Source = "vendor\defuddle.js"; Entry = "vendor/defuddle.js" },
  @{ Source = "vendor\defuddle-LICENSE.txt"; Entry = "vendor/defuddle-LICENSE.txt" }
)

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Remove-Item -LiteralPath $xpi -Force -ErrorAction SilentlyContinue

$spec = @{
  Root = $root
  Xpi = $xpi
  Entries = $entries
} | ConvertTo-Json -Depth 5 -Compress

$env:LOCAL_PAGE_SUMMARIZER_XPI_SPEC = $spec
$python = Get-Command python -ErrorAction SilentlyContinue
$pythonScript = @'
import json
import os
import pathlib
import zipfile

spec = json.loads(os.environ["LOCAL_PAGE_SUMMARIZER_XPI_SPEC"])
root = pathlib.Path(spec["Root"])
xpi = pathlib.Path(spec["Xpi"])

with zipfile.ZipFile(xpi, "w", compression=zipfile.ZIP_STORED) as archive:
    for item in spec["Entries"]:
        source = root / item["Source"]
        if not source.is_file():
            raise FileNotFoundError(f"Missing XPI source file: {source}")
        archive.write(source, item["Entry"])
'@

try {
  if ($python) {
    $pythonScript | & $python.Source -
  } else {
    $py = Get-Command py -ErrorAction Stop
    $pythonScript | & $py.Source -3 -
  }
} finally {
  Remove-Item Env:\LOCAL_PAGE_SUMMARIZER_XPI_SPEC -ErrorAction SilentlyContinue
}

Write-Host $xpi
tar -tf $xpi
