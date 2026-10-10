# _serve_tunnel.ps1: run the PERMANENT Cloudflare named tunnel for the quiz.
#   - Remotely-managed tunnel 8dc5036b-0729-4ac2-8918-d6b2ca131ff3 (created 10 Oct 2026 via API)
#   - Run by TOKEN (ingress config lives on Cloudflare's side, not in a local config.yml)
#   - Ingress: https://8dc5036b-0729-4ac2-8918-d6b2ca131ff3.cfargotunnel.com -> http://localhost:8002
#   - Token file: %LOCALAPPDATA%\hermes\cache\scratch\rtoken.txt
# Detached (Start-Process) so it survives Hermes task/session rotation.
# Re-runnable: skips if a cloudflared for THIS tunnel is already up.
# Stop: taskkill the cloudflared process whose CommandLine contains the tunnel id.
$cf      = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$tunid   = '8dc5036b-0729-4ac2-8918-d6b2ca131ff3'
$tokfile = 'C:\Users\Laptop K1\AppData\Local\hermes\cache\scratch\rtoken.txt'
$tmp     = 'C:\Users\Laptop K1\AppData\Local\Temp'

$token = (Get-Content $tokfile -Raw).Trim()
if (-not $token) { Write-Output "ERROR: empty token file $tokfile"; exit 1 }

$have = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
        Where-Object { $_.CommandLine -like "*$tunid*" }
if ($have) {
  Write-Output "TUNNEL_ALREADY pid=$($have.ProcessId)"
} else {
  Remove-Item "$tmp\cftunnel_quiz.out","$tmp\cftunnel_quiz.err" -ErrorAction SilentlyContinue
  $tun = Start-Process -FilePath $cf -ArgumentList 'tunnel','run','--token',$token `
    -WindowStyle Hidden -RedirectStandardOutput "$tmp\cftunnel_quiz.out" -RedirectStandardError "$tmp\cftunnel_quiz.err" -PassThru
  Write-Output "TUNNEL_STARTED pid=$($tun.Id)"
}

Start-Sleep -Seconds 10
Write-Output "Registered connections:"
Select-String -Path "$tmp\cftunnel_quiz.err" -Pattern 'Registered tunnel connection' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.Line }
Write-Output "Errors (if any):"
Select-String -Path "$tmp\cftunnel_quiz.err" -Pattern ' ERR ' -ErrorAction SilentlyContinue |
  Select-Object -Last 4 | ForEach-Object { $_.Line }
