# Minimal local server for the CourtSense app (no installs needed).
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8080] [-NoBrowser]
#
# Besides static files it exposes a small API used by "Import from link":
#   GET /api/import?url=<video page or file URL>   -> starts a download job (yt-dlp), returns {id,status}
#   GET /api/import/status?id=<id>                   -> {status: running|done|error, progress, file, title}
#   GET /downloads/<file>                            -> the downloaded video
# yt-dlp.exe is downloaded into .\tools on first use.
param([int]$Port = 8080, [switch]$NoBrowser)

$root = Join-Path $PSScriptRoot 'app'
$downloads = Join-Path $PSScriptRoot 'downloads'
$tools = Join-Path $PSScriptRoot 'tools'
$ytdlp = Join-Path $tools 'yt-dlp.exe'
$ytdlpUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
New-Item -ItemType Directory -Force -Path $downloads, $tools | Out-Null

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'
  '.jpg' = 'image/jpeg'; '.ico' = 'image/x-icon'; '.wasm' = 'application/wasm'; '.task' = 'application/octet-stream'
  '.mp4' = 'video/mp4'; '.webm' = 'video/webm'; '.mov' = 'video/quicktime'; '.mkv' = 'video/x-matroska'; '.m4v' = 'video/mp4'
}
$jobs = @{}

function Send-Json($res, $obj, [int]$code = 200) {
  $res.StatusCode = $code
  $res.ContentType = 'application/json; charset=utf-8'
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-File($res, $file) {
  $ext = [IO.Path]::GetExtension($file).ToLower()
  $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
  $res.Headers.Add('Cache-Control', 'no-cache')
  $fs = [IO.File]::OpenRead($file)
  try { $res.ContentLength64 = $fs.Length; $fs.CopyTo($res.OutputStream) } finally { $fs.Close() }
}

function Read-Shared($path) {
  if (-not (Test-Path $path)) { return '' }
  try {
    $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
    $sr = New-Object IO.StreamReader($fs)
    $text = $sr.ReadToEnd(); $sr.Close(); return $text
  } catch { return '' }
}

function Get-JobId($url) {
  $sha = [Security.Cryptography.SHA1]::Create()
  $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($url))
  return -join ($hash[0..5] | ForEach-Object { $_.ToString('x2') })
}

function Find-Video($id) {
  Get-ChildItem -Path $downloads -Filter "$id.*" -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.mp4', '.webm', '.mov', '.mkv', '.m4v' } | Select-Object -First 1
}

function Get-Status($id) {
  $title = (Read-Shared (Join-Path $downloads "$id.title")).Trim()
  $video = Find-Video $id
  $proc = $jobs[$id]
  $running = $proc -and -not $proc.HasExited
  if ($video -and -not $running) { return @{ id = $id; status = 'done'; file = $video.Name; title = $title; size = $video.Length } }
  if ($running) {
    $log = Read-Shared (Join-Path $downloads "$id.log")
    $m = [regex]::Matches($log, '\[download\]\s+([\d.]+)%')
    $p = if ($m.Count) { [double]$m[$m.Count - 1].Groups[1].Value } else { 0 }
    return @{ id = $id; status = 'running'; progress = $p; title = $title }
  }
  $err = (Read-Shared (Join-Path $downloads "$id.err")).Trim()
  $lines = $err -split "`n" | Where-Object { $_ -match 'ERROR' }
  $msg = if ($lines) { ($lines | Select-Object -Last 1).Trim() } elseif ($err) { ($err -split "`n" | Select-Object -Last 1).Trim() } else { 'Download failed or no video found at that link.' }
  return @{ id = $id; status = 'error'; error = $msg }
}

function Start-Import($url) {
  if ($url -notmatch '^https?://' -or $url -match '["\s]') { return @{ status = 'error'; error = 'Please paste a full http(s) link.' } }
  $id = Get-JobId $url
  $existing = Get-Status $id
  if ($existing.status -in 'done', 'running') { return $existing }
  if (-not (Test-Path $ytdlp)) {
    Write-Host 'Downloading yt-dlp (first use only)...'
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri $ytdlpUrl -OutFile $ytdlp -UseBasicParsing
    } catch { return @{ status = 'error'; error = "Could not download yt-dlp: $($_.Exception.Message)" } }
  }
  Remove-Item -Path (Join-Path $downloads "$id.*") -Force -ErrorAction SilentlyContinue
  $out = Join-Path $downloads "$id.%(ext)s"
  # Prefer browser-playable H.264 MP4 up to 1080p. Video-only streams are fine (no audio needed), so no ffmpeg is required.
  $fmt = 'bv*[ext=mp4][vcodec^=avc1][height<=1080]/b[ext=mp4][height<=1080]/bv*[ext=mp4][height<=1080]/b[ext=mp4]/bv*[ext=webm][height<=1080]/b'
  $argLine = "--no-playlist --no-part --newline --no-mtime -f `"$fmt`" -o `"$out`" --print-to-file `"%(title)s`" `"$(Join-Path $downloads "$id.title")`" `"$url`""
  $jobs[$id] = Start-Process -FilePath $ytdlp -ArgumentList $argLine -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $downloads "$id.log") -RedirectStandardError (Join-Path $downloads "$id.err")
  Write-Host "Importing $url -> $id"
  return @{ id = $id; status = 'running'; progress = 0 }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch { Write-Host "Could not start on port $Port. Try: serve.ps1 -Port 8090"; exit 1 }
Write-Host "CourtSense running at http://localhost:$Port/  (Ctrl+C to stop)"
if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request; $res = $ctx.Response
    try {
      $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
      if ($path -eq '/api/import') {
        Send-Json $res (Start-Import ([string]$req.QueryString['url']).Trim())
      } elseif ($path -eq '/api/import/status') {
        $id = [string]$req.QueryString['id']
        if ($id -notmatch '^[0-9a-f]{12}$') { Send-Json $res @{ status = 'error'; error = 'bad id' } 400 } else { Send-Json $res (Get-Status $id) }
      } elseif ($path -eq '/api/health') {
        Send-Json $res @{ ok = $true; import = $true }
      } else {
        $base = $root; $rel = $path.TrimStart('/')
        if ($rel.StartsWith('downloads/')) { $base = $downloads; $rel = $rel.Substring(10) }
        if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
        $file = [IO.Path]::GetFullPath((Join-Path $base $rel))
        if ($file.StartsWith([IO.Path]::GetFullPath($base)) -and (Test-Path $file -PathType Leaf)) { Send-File $res $file }
        else { $res.StatusCode = 404 }
      }
    } catch {
      Write-Host "Request error: $($_.Exception.Message)"
      try { $res.StatusCode = 500 } catch {}
    } finally {
      try { $res.OutputStream.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
