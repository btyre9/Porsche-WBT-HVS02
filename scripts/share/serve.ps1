<#
  serve.ps1 — tiny local web server for a shared WBT package (review copy or
  LMS test copy). Needs nothing installed: Windows PowerShell 5.1 + .NET only.

  The course loads its data, captions and cue files with fetch(), which browsers
  block for pages opened straight from disk, so a shared copy has to be served.
  The launcher (.bat) runs this with the folder in $env:WBT_DIR, so paths with
  apostrophes or commas (OneDrive "Someone's files") are safe.

    -Root   folder to serve (relative to WBT_DIR)
    -Port   first port to try; the next nine are tried if it is taken
    -Open   page to open in the browser, e.g. /player/index.html
    -Name   shown in the console window
    -IdleHours  stop by itself after this long with no requests
#>
param(
  [string]$Root = 'site',
  [int]$Port = 8790,
  [string]$Open = '/',
  [string]$Name = 'WBT course',
  [double]$IdleHours = 4,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$base = if ($env:WBT_DIR) { $env:WBT_DIR } else { Split-Path -Parent $PSCommandPath }
$rootPath = [IO.Path]::GetFullPath((Join-Path $base $Root))
if (-not (Test-Path -LiteralPath $rootPath)) { Write-Host "Folder not found: $rootPath" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
$token = [IO.Path]::GetFileName($rootPath.TrimEnd('\')) + '|' + $rootPath

# Already running for this folder? Just open the page again.
for ($p = $Port; $p -lt $Port + 10; $p++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 "http://localhost:$p/__wbt_ping"
    if ($r.Content -eq $token) { if (-not $NoBrowser) { Start-Process "http://localhost:$p$Open" }; exit 0 }
  } catch {}
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

public static class WbtServer {
  static string root;
  static string token;
  static long lastHit = DateTime.UtcNow.Ticks;

  static readonly Dictionary<string, string> Types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
    {".html","text/html; charset=utf-8"}, {".htm","text/html; charset=utf-8"}, {".js","text/javascript; charset=utf-8"},
    {".mjs","text/javascript; charset=utf-8"}, {".css","text/css; charset=utf-8"}, {".json","application/json; charset=utf-8"},
    {".xml","application/xml; charset=utf-8"}, {".txt","text/plain; charset=utf-8"}, {".vtt","text/vtt; charset=utf-8"},
    {".webp","image/webp"}, {".png","image/png"}, {".jpg","image/jpeg"}, {".jpeg","image/jpeg"}, {".gif","image/gif"},
    {".svg","image/svg+xml"}, {".ico","image/x-icon"}, {".mp3","audio/mpeg"}, {".wav","audio/wav"}, {".m4a","audio/mp4"},
    {".ogg","audio/ogg"}, {".mp4","video/mp4"}, {".m4v","video/mp4"}, {".webm","video/webm"}, {".ttf","font/ttf"},
    {".otf","font/otf"}, {".woff","font/woff"}, {".woff2","font/woff2"}, {".pdf","application/pdf"}
  };

  public static int Start(string rootPath, string tok, int firstPort, double idleHours) {
    root = rootPath.TrimEnd('\\') + "\\";
    token = tok;
    HttpListener l = null; int port = 0;
    for (int p = firstPort; p < firstPort + 10 && l == null; p++) {
      var t = new HttpListener();
      t.Prefixes.Add("http://localhost:" + p + "/");
      try { t.Start(); l = t; port = p; } catch (HttpListenerException) { t.Close(); }
    }
    if (l == null) return 0;
    var listener = l;
    new Thread(() => {
      while (true) {
        try { var ctx = listener.GetContext(); Interlocked.Exchange(ref lastHit, DateTime.UtcNow.Ticks); ThreadPool.QueueUserWorkItem(_ => Handle(ctx)); }
        catch { return; }
      }
    }) { IsBackground = true }.Start();
    new Thread(() => {
      while (true) {
        Thread.Sleep(60000);
        if (TimeSpan.FromTicks(DateTime.UtcNow.Ticks - Interlocked.Read(ref lastHit)).TotalHours > idleHours) Environment.Exit(0);
      }
    }) { IsBackground = true }.Start();
    return port;
  }

  static void Handle(HttpListenerContext ctx) {
    var req = ctx.Request; var res = ctx.Response;
    try {
      string rel = Uri.UnescapeDataString(req.Url.AbsolutePath);
      if (rel == "/__wbt_ping") { Send(res, 200, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes(token)); return; }
      string path = Path.GetFullPath(Path.Combine(root, rel.TrimStart('/').Replace('/', '\\')));
      if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase) && path + "\\" != root) { Send(res, 403, "text/plain", Encoding.UTF8.GetBytes("Forbidden")); return; }
      if (Directory.Exists(path)) path = Path.Combine(path, "index.html");
      if (!File.Exists(path)) { Send(res, 404, "text/plain", Encoding.UTF8.GetBytes("Not found: " + rel)); return; }

      string type; if (!Types.TryGetValue(Path.GetExtension(path), out type)) type = "application/octet-stream";
      res.ContentType = type;
      res.AddHeader("Cache-Control", "no-store");
      res.AddHeader("Accept-Ranges", "bytes");
      using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
        long len = fs.Length, start = 0, end = len - 1;
        string range = req.Headers["Range"];
        if (!string.IsNullOrEmpty(range) && range.StartsWith("bytes=")) {
          string[] parts = range.Substring(6).Split(',')[0].Split('-');
          if (parts[0].Length > 0) { start = long.Parse(parts[0]); if (parts.Length > 1 && parts[1].Length > 0) end = Math.Min(long.Parse(parts[1]), len - 1); }
          else if (parts.Length > 1 && parts[1].Length > 0) { start = Math.Max(0, len - long.Parse(parts[1])); }
          if (start > end || start >= len) { res.StatusCode = 416; res.AddHeader("Content-Range", "bytes */" + len); res.Close(); return; }
          res.StatusCode = 206;
          res.AddHeader("Content-Range", "bytes " + start + "-" + end + "/" + len);
        }
        long count = end - start + 1;
        res.ContentLength64 = count;
        if (req.HttpMethod == "HEAD") { res.Close(); return; }
        fs.Seek(start, SeekOrigin.Begin);
        byte[] buf = new byte[81920];
        while (count > 0) {
          int n = fs.Read(buf, 0, (int)Math.Min(buf.Length, count));
          if (n <= 0) break;
          res.OutputStream.Write(buf, 0, n);
          count -= n;
        }
      }
      res.Close();
    } catch { try { res.Abort(); } catch { } }
  }

  static void Send(HttpListenerResponse res, int code, string type, byte[] body) {
    res.StatusCode = code; res.ContentType = type; res.ContentLength64 = body.Length;
    res.OutputStream.Write(body, 0, body.Length); res.Close();
  }
}
'@

$port = [WbtServer]::Start($rootPath, $token, $Port, $IdleHours)
if ($port -eq 0) { Write-Host "Could not start: ports $Port-$($Port + 9) are all in use." -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

$url = "http://localhost:$port$Open"
$Host.UI.RawUI.WindowTitle = "$Name - keep this window open"
Write-Host ''
Write-Host "  $Name" -ForegroundColor White
Write-Host "  Running at $url" -ForegroundColor Green
Write-Host ''
Write-Host '  Keep this window open while you use the course.'
Write-Host '  Close it when you are done.'
Write-Host ''
if (-not $NoBrowser) { Start-Process $url }
while ($true) { Start-Sleep -Seconds 3600 }
