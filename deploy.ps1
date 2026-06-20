# deploy.ps1 — คัดลอกโค้ด V2 ไปยัง runtime (C:\) แล้ว restart pm2
# รันบน "เครื่องที่รัน runtime" — เปิด PowerShell ในโฟลเดอร์ต้นทาง (ที่มีไฟล์นี้) แล้วสั่ง:
#     .\deploy.ps1
# หรือกำหนดเอง: .\deploy.ps1 -Dest "C:\imps_service V2" -Pm2Name "imps_service_v2"
#
# จุดประสงค์:
#   1) copy ทั้งโฟลเดอร์ src/ (กันตกหล่นแบบ partial ที่ทำให้ db.js ไม่ไป → migration ไม่รัน → error is_estimated)
#   2) sync package.json + package-lock.json แล้ว npm ci เฉพาะตอน lockfile เปลี่ยน
#      (ต้นเหตุ "npm i ซ้ำตลอด": เดิม copy แค่ src/ → package.json บน runtime เก่า → npm prune winston ทิ้ง → Cannot find module)

param(
    [string]$Dest    = "C:\imps_service V2",   # โฟลเดอร์ runtime ปลายทาง (แก้ให้ตรงเครื่องคุณ)
    [string]$Pm2Name = "imps_service_v2",      # ชื่อ process ใน pm2 (เช็คด้วย `pm2 list`)
    [string]$Zip     = ""                       # artifact จาก make-deploy-zip.ps1 (ถ้าใส่ จะแตก zip มาเป็นต้นทาง แทน $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

# ต้นทาง: ถ้าใส่ -Zip ให้แตก artifact ลง temp แล้วใช้เป็นต้นทาง (ครบเสมอ ไม่มี partial); ไม่งั้นใช้โฟลเดอร์ที่สคริปต์อยู่
$StagingTemp = $null
if ($Zip) {
    if (-not (Test-Path $Zip)) { Write-Host "ไม่พบไฟล์ zip: $Zip" -ForegroundColor Red; exit 1 }
    $StagingTemp = Join-Path $env:TEMP ("imps_deploy_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
    Write-Host "แตก artifact -> $StagingTemp" -ForegroundColor Cyan
    Expand-Archive -Path $Zip -DestinationPath $StagingTemp -Force
    $SourceRoot = $StagingTemp
} else {
    $SourceRoot = $PSScriptRoot                # โฟลเดอร์ที่ไฟล์นี้อยู่ = ต้นทาง
}
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

# 3) sync package.json + package-lock.json แล้วลง deps เฉพาะเมื่อ lockfile เปลี่ยน
#    (กัน npm prune dependency ใหม่ทิ้ง เช่น winston / winston-daily-rotate-file)
$SrcPkg   = Join-Path $SourceRoot "package.json"
$SrcLock  = Join-Path $SourceRoot "package-lock.json"
$HashFile = Join-Path $Dest ".deploy-lock-hash"

if (-not (Test-Path $SrcPkg))  { Write-Host "ไม่พบ package.json ต้นทาง: $SrcPkg" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $SrcLock)) { Write-Host "ไม่พบ package-lock.json ต้นทาง: $SrcLock (รัน 'npm install' บน dev ก่อน commit)" -ForegroundColor Red; exit 1 }

# hash lockfile ต้นทาง เทียบกับที่เคย deploy ไว้
$srcLockHash = (Get-FileHash $SrcLock -Algorithm SHA256).Hash
$prevHash    = if (Test-Path $HashFile) { (Get-Content $HashFile -Raw).Trim() } else { "" }

# copy manifest ขึ้น runtime ให้ตรงกับ src ที่เพิ่ง deploy (สำคัญ: ไม่งั้น npm จะ prune ตาม package.json เก่า)
Copy-Item $SrcPkg  (Join-Path $Dest "package.json")      -Force
Copy-Item $SrcLock (Join-Path $Dest "package-lock.json") -Force

$needInstall = ($srcLockHash -ne $prevHash) -or (-not (Test-Path (Join-Path $Dest "node_modules")))
if ($needInstall) {
    Write-Host "lockfile เปลี่ยน (หรือยังไม่มี node_modules) -> npm ci" -ForegroundColor Cyan
    Push-Location $Dest
    npm ci
    $ciExit = $LASTEXITCODE
    Pop-Location
    if ($ciExit -ne 0) { Write-Host "npm ci ล้มเหลว (exit $ciExit) — เช็ก log ด้านบน" -ForegroundColor Red; exit 1 }
    Set-Content -Path $HashFile -Value $srcLockHash -Encoding ASCII
    Write-Host "ลง deps เสร็จ" -ForegroundColor Green
} else {
    Write-Host "deps ไม่เปลี่ยน — ข้าม npm ci" -ForegroundColor Green
}

# 4) restart pm2
Write-Host "restart pm2: $Pm2Name" -ForegroundColor Cyan
pm2 restart $Pm2Name
if (-not $?) { Write-Host "restart ไม่ผ่าน — เช็คชื่อ process ด้วย 'pm2 list' แล้วใส่ -Pm2Name ให้ถูก" -ForegroundColor Red; exit 1 }

# เก็บกวาด temp staging (ถ้าแตกมาจาก -Zip)
if ($StagingTemp -and (Test-Path $StagingTemp)) {
    Remove-Item $StagingTemp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== เสร็จ — ตรวจ log ยืนยัน (pm2 logs $Pm2Name) ===" -ForegroundColor Green
Write-Host "ควรเห็นตอน start:"
Write-Host "  [DB Schema] Checked/Added column is_estimated to vehicles"
Write-Host "  [DB Schema] Checked/Added column mirror_edge_zones ..."
Write-Host "  [Straddling] config loaded: axle_tol=3 ..."
Write-Host "  [EdgeMirror] config loaded: ON/OFF ..."
Write-Host ""
Write-Host "ถ้า EdgeMirror = OFF และต้องการเปิด → ตั้ง mirror_edge_zones ใน DB (ดู docs/config-guide.md)"
