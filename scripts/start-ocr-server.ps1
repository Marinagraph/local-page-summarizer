$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root ".venv-ocr"
$python = Join-Path $venv "Scripts\python.exe"
$ocrPort = 2010
$healthUrl = "http://127.0.0.1:2010/health"
$torchIndexUrl = "https://download.pytorch.org/whl/cu128"
$torchPackages = @("torch==2.11.0+cu128", "torchvision==0.26.0+cu128")

function Stop-StaleOcrServer {
  $connections = @(Get-NetTCPConnection -LocalPort $ocrPort -State Listen -ErrorAction SilentlyContinue)
  $processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -and $_ -gt 0 })

  if (-not $processIds.Count) {
    throw "An old OCR server is responding at $healthUrl, but no listening process was found on port $ocrPort."
  }

  foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    $processName = if ($process) { $process.ProcessName } else { "unknown" }
    Write-Warning "Stopping stale OCR server process $processId ($processName) on port $ocrPort."
    Stop-Process -Id $processId -Force -ErrorAction Stop
  }

  Start-Sleep -Milliseconds 800
}

$health = $null
try {
  $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
} catch {
  # Server is not running yet.
}

if ($health -and $health.StatusCode -eq 200) {
  $healthBody = $null
  try {
    $healthBody = $health.Content | ConvertFrom-Json
  } catch {
    # Treat unknown health responses as stale servers on the OCR port.
  }

  if ($healthBody -and $healthBody.gpu -and "$($healthBody.gpu)".StartsWith("cuda:")) {
    Write-Host "GPU OCR server is already running at $healthUrl ($($healthBody.gpu))"
    exit 0
  }

  Write-Warning "A server is already running at $healthUrl, but it is not the current GPU OCR server. Restarting it."
  Stop-StaleOcrServer
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
& $python -m pip install --upgrade --index-url $torchIndexUrl @torchPackages
& $python -m pip install -r (Join-Path $root "ocr-server\requirements.txt")

$gpuName = & $python -c "import sys, torch; available=torch.cuda.is_available(); print(torch.cuda.get_device_name(0) if available else 'NO_CUDA_GPU'); sys.exit(0 if available else 1)"
if ($LASTEXITCODE -ne 0) {
  throw "OCR requires a CUDA GPU. Install a CUDA-enabled PyTorch build in .venv-ocr or run on a CUDA-capable machine."
}

Write-Host "OCR GPU: $gpuName"
$env:OCR_GPU = "1"
$env:PYTHONPATH = Join-Path $root "ocr-server"
& $python -m uvicorn server:app --host 127.0.0.1 --port 2010
