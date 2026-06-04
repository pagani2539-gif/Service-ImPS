const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getFiles(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            results = results.concat(getFiles(filePath));
        } else if (filePath.endsWith('.js')) {
            results.push(filePath);
        }
    });
    return results;
}

const srcDir = path.join(__dirname, '..', 'src');
const files = getFiles(srcDir);
let ok = true;

console.log(`Checking syntax of ${files.length} files...`);
files.forEach(file => {
    try {
        execSync(`node --check "${file}"`);
        console.log(`[OK] ${path.relative(srcDir, file)}`);
    } catch (err) {
        console.error(`[FAIL] ${path.relative(srcDir, file)}:`, err.message);
        ok = false;
    }
});

if (!ok) {
    process.exit(1);
} else {
    console.log("All files checked successfully!");
}
