# make-deploy-zip.ps1 — สร้าง artifact deploy ก้อนเดียว (รันบนเครื่อง dev)
# ใช้ git archive ดึง "เฉพาะไฟล์ที่ commit แล้ว" ทั้งต้นไม้ → ครบเสมอ ไม่มีทางตกหล่น
# และไม่ติด node_modules/.env (ตาม .gitignore) → พก zip ไฟล์เดียวไป server แทนการลากไฟล์หลวมๆ
#
# วิธีใช้:
#     .\make-deploy-zip.ps1
# จากนั้นเอา imps-deploy_<วันเวลา>.zip ไปแตกบน server แล้วรัน .\deploy.ps1 -Zip <ไฟล์>

$ErrorActionPreference = "Stop"
$SourceRoot = $PSScriptRoot
Set-Location $SourceRoot

# ต้องอยู่ใน git repo
git rev-parse --is-inside-work-tree | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "ไม่ใช่ git repo: $SourceRoot" -ForegroundColor Red; exit 1 }

# เตือนถ้ามีไฟล์ที่ยังไม่ commit (git archive จะไม่เก็บของที่ยังไม่ commit)
$dirty = git status --porcelain
if ($dirty) {
    Write-Host "เตือน: มีไฟล์ที่ยังไม่ commit — จะ 'ไม่' ติดไปกับ zip นี้:" -ForegroundColor Yellow
    $dirty | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    Write-Host "ถ้าต้องการให้ติดไปด้วย ให้ git commit ก่อน แล้วรันสคริปต์นี้ใหม่" -ForegroundColor Yellow
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$zip   = Join-Path $SourceRoot "imps-deploy_$stamp.zip"

Write-Host "กำลังสร้าง artifact จาก HEAD ..." -ForegroundColor Cyan
git archive --format=zip -o "$zip" HEAD
if ($LASTEXITCODE -ne 0) { Write-Host "git archive ล้มเหลว" -ForegroundColor Red; exit 1 }

Write-Host "เสร็จ -> $zip" -ForegroundColor Green
Write-Host "ขั้นต่อไป (บน server): แตก zip นี้ แล้วรัน  .\deploy.ps1 -Zip `"$zip`"" -ForegroundColor Cyan
