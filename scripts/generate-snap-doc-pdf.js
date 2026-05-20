const path = require("path");
const fs = require("fs");

const htmlPath = path.join(__dirname, "../docs/snap-fix-report.html");
const pdfPath = path.join(__dirname, "../docs/LPR_Snap_Fix_Report_TH.pdf");

async function main() {
  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch {
    console.error("Installing puppeteer...");
    require("child_process").execSync("npm install puppeteer@23 --no-save", {
      cwd: path.join(__dirname, ".."),
      stdio: "inherit",
    });
    puppeteer = require("puppeteer");
  }

  const html = fs.readFileSync(htmlPath, "utf8");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.pdf({
    path: pdfPath,
    format: "A4",
    printBackground: true,
    margin: { top: "15mm", bottom: "15mm", left: "12mm", right: "12mm" },
  });
  await browser.close();
  console.log("PDF created:", pdfPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
