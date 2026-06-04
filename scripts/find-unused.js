const fs = require('fs');
const path = require('path');

// 1. Get all JS files in src/
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

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const allFiles = getFiles(srcDir);

// Map absolute path to its dependencies
const dependencyMap = new Map();

// Helper to resolve requires
function resolveRequire(currentFilePath, requirePath) {
    // If it's a relative path (starts with . or ..)
    if (requirePath.startsWith('.')) {
        const dir = path.dirname(currentFilePath);
        let resolved = path.resolve(dir, requirePath);
        
        // Check standard resolution extensions/index
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            return resolved;
        }
        if (fs.existsSync(resolved + '.js')) {
            return resolved + '.js';
        }
        const indexFile = path.join(resolved, 'index.js');
        if (fs.existsSync(indexFile)) {
            return indexFile;
        }
    }
    return null;
}

// 2. Parse requires in each file
allFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    // Regex to match require('...') or require("...")
    const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
    let match;
    const deps = [];
    while ((match = requireRegex.exec(content)) !== null) {
        const depPath = match[1];
        const resolved = resolveRequire(file, depPath);
        if (resolved) {
            deps.push(resolved);
        }
    }
    dependencyMap.set(file, deps);
});

// 3. Trace reachability from entry points
// Main entry points of the application:
// - src/app.js (Main runtime)
// - src/app.config.js (PM2 runtime config)
const entryPoints = [
    path.join(srcDir, 'app.js'),
    path.join(srcDir, 'app.config.js')
];

const visited = new Set();

function dfs(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const deps = dependencyMap.get(file) || [];
    deps.forEach(dep => dfs(dep));
}

// Start DFS from entry points
entryPoints.forEach(entry => {
    if (fs.existsSync(entry)) {
        dfs(entry);
    }
});

// 4. Print results
console.log("=== Dependency Analysis ===");
console.log(`Total files in src/: ${allFiles.length}`);
console.log(`Reachable files: ${visited.size}`);

const unusedFiles = allFiles.filter(file => !visited.has(file));

if (unusedFiles.length > 0) {
    console.log("\n❌ Found unused files in src/:");
    unusedFiles.forEach(file => {
        console.log(`- ${path.relative(rootDir, file)}`);
    });
} else {
    console.log("\n✅ All files in src/ are reachable and used!");
}
