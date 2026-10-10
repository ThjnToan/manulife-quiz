# _serve_quiz.ps1: start the quiz server on :8002 + its own cloudflared quick tunnel.
#   - node server.js  (serves the UI + realtime state on 0.0.0.0:8002)
#   - cloudflared quick tunnel -> https://<random>.trycloudflare.com
# Detached (Start-Process) so both survive Hermes task/session rotation.
# Re-runnable: skips each piece if already up. Logs in %TEMP%.
$proj = 'C:\Users\Laptop K1\Documents\ManulifeQuiz'
$cf   = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$tmp  = 'C:\Users\Laptop K1\AppData\Local\Temp'
$node = (Get-Command node -ErrorAction Stop).Source

$up = Get-NetTCPConnection -LocalPort 8002 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($up) {
  Write-Output "SERVER_ALREADY pid=$($up.OwningProcess)"
} else {
  $srv = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $proj -WindowStyle Hidden `
    -RedirectStandardOutput "$tmp\quiz8002_srv.out" -RedirectStandardError "$tmp\quiz8002_srv.err" -PassThru
  Write-Output "SERVER_STARTED pid=$($srv.Id)"
}

$have = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -like '*8002*' }
if ($have) {
  Write-Output "TUNNEL_ALREADY pid=$($have.ProcessId)"
} else {
  Remove-Item "$tmp\cf_tunnel8002.err" -ErrorAction SilentlyContinue
  $tun = Start-Process -FilePath $cf -ArgumentList 'tunnel','--url','http://localhost:8002','--no-autoupdate' `
    -WindowStyle Hidden `
    -RedirectStandardOutput "$tmp\cf_tunnel8002.out" -RedirectStandardError "$tmp\cf_tunnel8002.err" -PassThru
  Write-Output "TUNNEL_STARTED pid=$($tun.Id)"
}

Start-Sleep -Seconds 3
Write-Output "JOIN_URL (read it fresh from the log):"
Select-String -Path "$tmp\cf_tunnel8002.err" -Pattern 'trycloudflare' -ErrorAction SilentlyContinue | ForEach-Object { $_.Line }
Write-Output "LAN alternative: http://<this-pc-ip>:8002  (same Wi-Fi only)"
