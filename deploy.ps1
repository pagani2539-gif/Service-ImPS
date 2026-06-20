# deploy.ps1 — คัดลอกโค้ด V2 ไปยัง runtime (C:\) แล้ว restart pm2
# รันบน "เครื่องที่รัน runtime" — เปิด PowerShell ในโฟลเดอร์ต้นทาง (ที่มีไฟล์นี้) แล้วสั่ง:
#     .\deploy.ps1
# หรือกำหนดเอง: .\deploy.ps1 -Dest "C:\imps_service V2" -Pm2Name "imps-service"
#
# จุดประสงค์: copy ทั้งโฟลเดอร์ src/ (กันตกหล่นแบบ partial ที่ทำให้ db.js ไม่ไป → migration ไม่รัน → error is_estimated)

param(
    [string]$Dest    = "C:\imps_service V2",   # โฟลเดอร์ runtime ปลายทาง (แก้ให้ตรงเครื่องคุณ)
    [string]$Pm2Name = "imps-service"          # ชื่อ process ใน pm2 (เช็คด้วย `pm2 list`)
)

$ErrorActionPreference = "Stop"
$SourceRoot = $PSScriptRoot                    # โฟลเดอร์ที่ไฟล์นี้อยู่ = ต้นทาง
$SrcDir  = Join-Path $SourceRoot "src"
$DestSrc = Join-Path $Dest "src"

Write-Host "=== IMPS V2 Deploy ===" -ForegroundColor Cyan
Write-Host "ต้นทาง : $SrcDir"
Write-Host "ปลายทาง: $DestSrc"

# ตรวจต้นทาง/ปลายทาง
if (-not (Test-Path $SrcDir))  { Write-Host "ไม่พบโฟลเดอร์ src ต้นทาง: $SrcDir" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $Dest))    { Write-Host "ไม่พบโฟลเดอร์ runtime ปลายทาง: $Dest (ใส่ -Dest ให้ถูก)" -ForegroundColor Red; exit 1 }

# 1) สำรอง src เดิมไว้ก่อน (กันพลาด ย้อนกลับได้)
$backup = Join-Path $Dest ("src_backup_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
if (Test-Path $DestSrc) {
    Write-Host "สำรอง src เดิม -> $backup" -ForegroundColor Yellow
    Copy-Item $DestSrc $backup -Recurse
}

# 2) copy src/ ทั้งโฟลเดอร์ (robocopy /MIR = ให้ตรงกับต้นทางเป๊ะ: เพิ่ม/ทับ/ลบไฟล์ที่ไม่มีแล้ว)
Write-Host "กำลังคัดลอก src/ ..." -ForegroundColor Cyan
robocopy $SrcDir $DestSrc /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
# robocopy exit code < 8 = สำเร็จ
if ($LASTEXITCODE -ge 8) { Write-Host "robocopy ล้มเหลว (code $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
Write-Host "คัดลอกเสร็จ" -ForegroundColor Green

# 3) restart pm2
Write-Host "restart pm2: $Pm2Name" -ForegroundColor Cyan
pm2 restart $Pm2Name
if (-not $?) { Write-Host "restart ไม่ผ่าน — เช็คชื่อ process ด้วย 'pm2 list' แล้วใส่ -Pm2Name ให้ถูก" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== เสร็จ — ตรวจ log ยืนยัน (pm2 logs $Pm2Name) ===" -ForegroundColor Green
Write-Host "ควรเห็นตอน start:"
Write-Host "  [DB Schema] Checked/Added column is_estimated to vehicles"
Write-Host "  [DB Schema] Checked/Added column mirror_edge_zones ..."
Write-Host "  [Straddling] config loaded: axle_tol=3 ..."
Write-Host "  [EdgeMirror] config loaded: ON/OFF ..."
Write-Host ""
Write-Host "ถ้า EdgeMirror = OFF และต้องการเปิด → ตั้ง mirror_edge_zones ใน DB (ดู docs/config-guide.md)"
