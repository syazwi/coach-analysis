# Minimal static file server for the CourtSense app (no installs needed).
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8080]
param([int]$Port = 8080, [switch]$NoBrowser)

$root = Join-Path $PSScriptRoot 'app'
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'
  '.jpg' = 'image/jpeg'; '.ico' = 'image/x-icon'; '.wasm' = 'application/wasm'; '.task' = 'application/octet-stream'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch { Write-Host "Could not start on port $Port. Try: serve.ps1 -Port 8090"; exit 1 }
Write-Host "CourtSense running at http://localhost:$Port/  (Ctrl+C to stop)"
if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ([string]::IsNullOrEmpty($path)) { $path = 'index.html' }
    $file = [System.IO.Path]::GetFullPath((Join-Path $root $path))
    $res = $ctx.Response
    if ($file.StartsWith([System.IO.Path]::GetFullPath($root)) -and (Test-Path $file -PathType Leaf)) {
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
    $res.OutputStream.Close()
  }
} finally {
  $listener.Stop()
}
