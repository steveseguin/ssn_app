/**
 * Patches node_modules dependencies that can't be committed to git.
 * Run automatically via `postinstall` in package.json.
 */

const fs = require('fs');
const path = require('path');

const patches = [];

let anyFailed = false;

for (const patch of patches) {
    const filePath = path.join(__dirname, '..', patch.file);
    if (!fs.existsSync(filePath)) {
        console.warn(`[patch-deps] SKIP (file not found): ${patch.file}`);
        continue;
    }
    const original = fs.readFileSync(filePath, 'utf8');
    if (original.includes(patch.to)) {
        console.log(`[patch-deps] already applied: ${patch.description}`);
        continue;
    }
    if (!original.includes(patch.from)) {
        console.warn(`[patch-deps] WARN: patch target not found (library may have changed): ${patch.description}`);
        anyFailed = true;
        continue;
    }
    const patched = original.replace(patch.from, patch.to);
    fs.writeFileSync(filePath, patched, 'utf8');
    console.log(`[patch-deps] applied: ${patch.description}`);
}

if (anyFailed) {
    console.warn('[patch-deps] one or more patches could not be applied — check for library updates');
}
