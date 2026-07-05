// Copies non-TypeScript runtime assets (e.g. the Python skill runner) into dist/,
// since `tsc` only emits compiled .ts sources. Tolerant of assets not existing yet.
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const DIST = path.resolve(__dirname, '..', 'dist');

// Glob-free recursive walk: copy any file whose extension is in ASSET_EXTS.
const ASSET_EXTS = new Set(['.py', '.cjs']);

function copyAssets(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      copyAssets(abs);
      continue;
    }
    if (!ASSET_EXTS.has(path.extname(entry.name))) continue;
    const rel = path.relative(SRC, abs);
    const dest = path.join(DIST, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    console.log(`[copy-assets] ${rel}`);
  }
}

copyAssets(SRC);
