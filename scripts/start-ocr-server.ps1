$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root ".venv-ocr"
$python = Join-Path $venv "Scripts\python.exe"
$healthUrl = "http://127.0.0.1:2010/health"

try {
  $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
  if ($health.StatusCode -eq 200) {
    $healthBody = $health.Content | ConvertFrom-Json
    if ($healthBody.gpu -and "$($healthBody.gpu)".StartsWith("cuda:")) {
      Write-Host "GPU OCR server is already running at $healthUrl ($($healthBody.gpu))"
      exit 0
    }

    throw "An OCR server is already running at $healthUrl, but it is not reporting a CUDA GPU. Stop the old server and start it again."
  }
} catch {
  if ($_.Exception.Message -like "*already running*") {
    throw
  }
  # Server is not running yet.
}

function Get-BasePython {
  $py311 = & py -3.11 -c "import sys; print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0 -and $py311) {
    return $py311.Trim()
  }

  $pythonExe = & python -c "import sys; print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0 -and $pythonExe) {
    return $pythonExe.Trim()
  }

  throw "Python 3.11+ is required."
}

if (Test-Path $python) {
  $version = & $python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
  if ($version -eq "3.13") {
    Write-Host "Removing Python 3.13 OCR virtualenv because EasyOCR dependencies are not reliable on it."
    Remove-Item -LiteralPath $venv -Recurse -Force
  }
}

if (-not (Test-Path $python)) {
  $basePython = Get-BasePython
  & $basePython -m venv $venv
}

& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $root "ocr-server\requirements.txt")

$gpuName = & $python -c "import sys, torch; available=torch.cuda.is_available(); print(torch.cuda.get_device_name(0) if available else 'NO_CUDA_GPU'); sys.exit(0 if available else 1)"
if ($LASTEXITCODE -ne 0) {
  throw "OCR requires a CUDA GPU. Install a CUDA-enabled PyTorch build in .venv-ocr or run on a CUDA-capable machine."
}

Write-Host "OCR GPU: $gpuName"
$env:OCR_GPU = "1"
$env:PYTHONPATH = Join-Path $root "ocr-server"
& $python -m uvicorn server:app --host 127.0.0.1 --port 2010
