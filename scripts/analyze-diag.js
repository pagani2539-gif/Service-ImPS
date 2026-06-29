// scripts/analyze-diag.js
// วิเคราะห์ diagnostic log ([Diag][...]) ที่เก็บตอน DIAG=1 — สรุปทุกหมวดเป็นตารางอ่านง่าย
//
// ใช้งาน:
//   node scripts/analyze-diag.js logs/info-2026-06-23.log [more.log ...]
//   (ไม่ใส่ไฟล์ = อ่านทุก logs/info-*.log อัตโนมัติ)
//
// อ่านอย่างเดียว ไม่แตะระบบ/DB. ทุกบรรทัด log เป็น JSON (winston) — message = `[Diag][Tag] {json}`

const fs = require("fs");
const path = require("path");

// ---------- โหลดไฟล์ ----------
let files = process.argv.slice(2);
if (files.length === 0) {
  const logDir = path.join(process.cwd(), "logs");
  try {
    files = fs.readdirSync(logDir)
      .filter((f) => /^info-.*\.log/.test(f))
      .map((f) => path.join(logDir, f));
  } catch { files = []; }
}
if (files.length === 0) {
  console.error("ไม่พบไฟล์ log — ระบุ path เช่น: node scripts/analyze-diag.js logs/info-2026-06-23.log");
  process.exit(1);
}

// ---------- parse ----------
const byTag = {}; // tag -> [payload, ...]
let totalLines = 0, diagLines = 0;
const reDiag = /^\[Diag\]\[(\w+(?:-\d+)?)\]\s+(\{.*\})$/;

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { console.error(`อ่านไฟล์ไม่ได้: ${file} (${e.message})`); continue; }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    totalLines++;
    let msg;
    try { msg = JSON.parse(line).message; } catch { continue; }
    if (typeof msg !== "string") continue;
    const m = msg.match(reDiag);
    if (!m) continue;
    const tag = m[1];
    let payload;
    try { payload = JSON.parse(m[2]); } catch { continue; }
    (byTag[tag] = byTag[tag] || []).push(payload);
    diagLines++;
  }
}

// ---------- helpers ----------
const tally = (arr, keyFn) => {
  const m = new Map();
  for (const x of arr) { const k = keyFn(x); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const stats = (nums) => {
  const a = nums.filter((n) => typeof n === "number" && !Number.isNaN(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { n: a.length, min: a[0], p50: q(0.5), p95: q(0.95), max: a[a.length - 1], avg: Math.round(a.reduce((s, v) => s + v, 0) / a.length) };
};
const hr = (s) => console.log("\n" + "=".repeat(70) + `\n  ${s}\n` + "=".repeat(70));
const fmtStat = (s) => s ? `n=${s.n} min=${s.min} avg=${s.avg} p50=${s.p50} p95=${s.p95} max=${s.max}` : "(ไม่มีข้อมูล)";

console.log(`อ่าน ${files.length} ไฟล์ · ${totalLines} บรรทัด · พบ [Diag] ${diagLines} บรรทัด`);
console.log("หมวดที่เจอ:", Object.keys(byTag).map((t) => `${t}(${byTag[t].length})`).join(", ") || "(ไม่มี — เปิด DIAG=1 หรือยัง?)");

// ---------- 1. Drop ↔ Orphan correlation (ปัญหา 1: คู่ถูก filter ตัด) ----------
const drops = (byTag.Drop || []).slice();
// GVW-1 ก็เป็น "คู่ที่หาย" ได้ → รวมเข้า correlation
for (const g of byTag["GVW-1"] || []) drops.push({ ...g, reason: "gvw=-1" });
const orphans = byTag.Orphan || [];
if (drops.length || orphans.length) {
  hr("1) Drop ↔ Orphan : คู่ครึ่งคันถูก filter ตัดก่อนเข้า buffer หรือไม่");
  console.log("Drops (straddle-related) แยกตามเหตุผล:");
  for (const [k, v] of tally(drops, (d) => d.reason || "?")) console.log(`   ${String(v).padStart(5)}  ${k}`);
  console.log(`\nOrphan ทั้งหมด: ${orphans.length}`);
  let matched = 0;
  const WIN_MS = 2500;
  for (const o of orphans) {
    if (o.stampMs == null) continue;
    const hit = drops.find((d) => d.stampMs != null && Math.abs(Number(d.lane) - Number(o.lane)) === 1 && Math.abs(d.stampMs - o.stampMs) <= WIN_MS);
    if (hit) matched++;
  }
  const pct = orphans.length ? Math.round((matched / orphans.length) * 100) : 0;
  console.log(`Orphan ที่มี drop เลนติดกันใน ±${WIN_MS}ms = ${matched} (${pct}%)  ← ยิ่งสูง = ยิ่งยืนยันว่าคู่ถูก filter ตัด`);
}

// ---------- 2. GVW=-1 (ปัญหา 2: กู้ได้ไหม) ----------
if (byTag["GVW-1"]) {
  const g = byTag["GVW-1"];
  hr("2) GVW=-1 : น้ำหนักล้อเชื่อได้ (กู้ได้) หรือเป็นขยะ");
  const floorOk = g.filter((x) => !x.implausible && /L0|R0/.test(x.zero || "") && x.axleSum >= 0); // ดูคร่าวๆ
  console.log(`รวม GVW=-1: ${g.length}`);
  console.log(`  implausible (ขยะชัด): ${g.filter((x) => x.implausible).length}`);
  console.log(`  ฝั่งศูนย์ข้างเดียวสม่ำเสมอ (เข้าข่ายครึ่งคันจริง): ${g.filter((x) => !x.implausible && /^(A\d+:L0 ?)+$|^(A\d+:R0 ?)+$/.test((x.zero || "").trim())).length}`);
  console.log(`  axleSum distribution: ${fmtStat(stats(g.map((x) => x.axleSum)))}`);
  console.log(`  แยกตามเลน:`); for (const [k, v] of tally(g, (x) => `lane ${x.lane}`)) console.log(`     ${String(v).padStart(4)}  ${k}`);
}

// ---------- 3. Orphan < floor (ปัญหา 3) ----------
if (orphans.length) {
  hr("3) Orphan เทียบ floor (gvw_ignored) : ควรทิ้งหรือเก็บ");
  const below = orphans.filter((o) => o.belowFloor);
  console.log(`Orphan ทั้งหมด: ${orphans.length} · ต่ำกว่า floor: ${below.length}`);
  console.log(`  GVW distribution (ทั้งหมด): ${fmtStat(stats(orphans.map((o) => o.gvw)))}`);
  console.log(`  GVW distribution (<floor):  ${fmtStat(stats(below.map((o) => o.gvw)))}`);
}

// ---------- 4. Buffer ≥2 (ปัญหา 4: greedy mis-pair) ----------
if (byTag.Buffer) {
  const b = byTag.Buffer;
  hr("4) Buffer ≥2 : first-match เสี่ยง mis-pair ไหม");
  console.log(`เหตุการณ์ buffer≥2: ${b.length}`);
  const passes = b.filter((x) => x.pass);
  console.log(`  คู่ที่ผ่านเงื่อนไข (มีตัวเลือก): ${passes.length}`);
  console.log("  → ถ้า incoming เดียวมีคู่ผ่าน >1 = มีโอกาสเลือกผิด (ดู group ด้านล่าง)");
  const byIncoming = new Map();
  for (const x of passes) { const k = x.incoming; (byIncoming.get(k) || byIncoming.set(k, []).get(k)).push(x); }
  let multi = 0;
  for (const [, list] of byIncoming) if (list.length > 1) multi++;
  console.log(`  incoming ที่มีคู่ผ่าน >1 ตัวพร้อมกัน: ${multi}  ← ถ้า 0 = ข้อ 4 ยังไม่ต้องแก้`);
}

// ---------- 5. บัส: Veh + Plate (ปัญหา 5) ----------
if (byTag.Veh) {
  const v = byTag.Veh;
  hr("5) บัส : ลายเซ็นฐานล้อหน้า แยก class + อัตราอ่านป้าย");
  console.log("frontWheelbase distribution แยกตาม class:");
  const byCls = new Map();
  for (const x of v) { const k = x.cls; (byCls.get(k) || byCls.set(k, []).get(k)).push(x); }
  for (const k of [...byCls.keys()].sort((a, b) => a - b)) {
    const list = byCls.get(k);
    const wb = stats(list.map((x) => x.frontWb));
    const noPlate = list.filter((x) => !x.plateRead).length;
    console.log(`  class ${String(k).padStart(2)}: n=${String(list.length).padStart(4)} | frontWb ${fmtStat(wb)} | NOPLATE ${noPlate}`);
  }
  if (byTag.Plate) {
    console.log("\nบัสที่รู้แน่จากป้าย (Plate exclude) — frontWb แยก class (ตั้งเกณฑ์ตัด class 3+ ให้สูงกว่าบรรทุก):");
    const p = byTag.Plate;
    const byClsP = new Map();
    for (const x of p) { const k = x.cls; (byClsP.get(k) || byClsP.set(k, []).get(k)).push(x); }
    for (const k of [...byClsP.keys()].sort((a, b) => a - b)) {
      console.log(`  class ${String(k).padStart(2)}: frontWb ${fmtStat(stats(byClsP.get(k).map((x) => x.frontWb)))}`);
    }
  }
  if (byTag.Bus) console.log(`\nบัสตัดด้วยฐานล้อ (class 2) แล้ว: ${byTag.Bus.length} — frontWb ${fmtStat(stats(byTag.Bus.map((x) => x.frontWb)))}`);
}

// ---------- เสริม: Pair / Violation / Class / Image ----------
if (byTag.Pair) {
  const p = byTag.Pair;
  hr("เสริม) Pair : Δ ของคู่ที่ merge สำเร็จ (ปรับหน้าต่างเวลา)");
  console.log(`  dTime(ms):   ${fmtStat(stats(p.map((x) => x.dTime)))}`);
  console.log(`  dSpeed:      ${fmtStat(stats(p.map((x) => x.dSpeed)))}`);
  console.log(`  axle-mismatch merges: ${p.filter((x) => x.mismatch).length}/${p.length}`);
}
if (byTag.Violation) {
  hr("เสริม) Violation : น้ำหนักเกินที่จับได้เพราะ merge (คุณค่าธุรกิจ)");
  console.log(`  รถน้ำหนักเกินที่ "ถ้าไม่ merge จะรอด" = ${byTag.Violation.length} คัน`);
  console.log(`  overweight% : ${fmtStat(stats(byTag.Violation.map((x) => Number(x.overweightPct))))}`);
}
if (byTag.Class) {
  hr("เสริม) Class3+ : ตรวจ misclassification");
  console.log("  axleCount distribution:");
  for (const [k, v] of tally(byTag.Class, (x) => `${x.axleCount} เพลา`)) console.log(`     ${String(v).padStart(4)}  ${k}`);
}
if (byTag.Image) {
  hr("เสริม) Image : รูปหายหลัง retry หมด");
  console.log(`  รวม: ${byTag.Image.length} · ขาด overview: ${byTag.Image.filter((x) => x.missOverview).length} · ขาด lpr: ${byTag.Image.filter((x) => x.missLpr).length}`);
}

console.log("\nเสร็จ. (per-lane counters ดูได้ในบรรทัด [Metrics Summary] ของ log โดยตรง: laneN_orphan/laneN_gvw1/...)");
