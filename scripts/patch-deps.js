/**
 * Patches node_modules dependencies that can't be committed to git.
 * Run automatically via `postinstall` in package.json.
 */

const fs = require('fs');
const path = require('path');

const patches = [{
    file: 'node_modules/tiktok-live-connector/dist/lib-CbB_CSnH.js',
    description: 'tiktok-live-connector 2.4.3: preserve headers when constructing a signing rate-limit error',
    from: 'Too many connections started, try again later.`, response.data);',
    to: 'Too many connections started, try again later.`, response);'
}, {
    file: 'node_modules/tiktok-live-connector/dist/lib-CbB_CSnH.js',
    description: 'tiktok-live-connector 2.4.3: allow short sign-server error messages',
    from: 'const msgLen = message.length;',
    to: 'const msgLen = Math.max(message.length, 19);'
}];

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
