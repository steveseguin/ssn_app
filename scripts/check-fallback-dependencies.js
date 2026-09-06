'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function matchesPattern(file, pattern) {
    const escaped = pattern.replace(/^\//, '').split('**').map(part => part.split('*')
        .map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
    return new RegExp(`^${escaped}$`).test(file);
}

function findReferences(text, file, inventory) {
    const references = new Set();
    const directory = path.posix.dirname(file);
    const add = raw => {
        if (/^(?:[a-z]+:|\/\/|#)/i.test(raw) || /[${}\\]/.test(raw)) return;
        const clean = raw.split(/[?#]/)[0];
        if (!/\.(?:js|mjs|css|json|geojson|wasm|data|onnx|woff2?|ttf|png|svg|jpe?g|gif|webp|html)$/i.test(clean)) return;
        const target = path.posix.normalize(clean.startsWith('/') ? clean.slice(1) : path.posix.join(directory, clean));
        if (inventory.has(target)) references.add(target);
    };
    for (const match of text.matchAll(/(?:\b(?:src|href)\s*=\s*["']([^"']+)["']|\burl\(\s*["']?([^\s)'";]+)|["']((?:\.\.?\/|thirdparty\/|shared\/|sources\/|games\/)[^"'\r\n]+)["'])/g)) {
        // Navigation links may intentionally open separately hosted apps such as Lite.
        if (/^href\s*=/.test(match[0]) && /\.html(?:[?#]|$)/.test(match[1] || '')) continue;
        add(match[1] || match[2] || match[3]);
    }
    return [...references];
}

function checkFallbackDependencies(root, patterns, optionalPatterns = []) {
    // Git's index includes sparse-checkout omissions, so missing files cannot hide from the gate.
    const files = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
    const inventory = new Set(files);
    const included = file => patterns.some(pattern => matchesPattern(file, pattern));
    const optional = file => optionalPatterns.some(pattern => matchesPattern(file, pattern));
    const missing = [];
    for (const file of files) {
        if (!included(file)) continue;
        const absolute = path.join(root, file);
        if (!fs.existsSync(absolute)) throw new Error(`Bundled source is missing: ${file}`);
        if (!/\.(html|js|mjs|css)$/.test(file)) continue;
        // Vendor internals contain platform imports and examples, not app entry points.
        if (file.startsWith('thirdparty/')) continue;
        for (const dependency of findReferences(fs.readFileSync(absolute, 'utf8'), file, inventory)) {
            if (!included(dependency) && !optional(dependency)) missing.push(`${file} -> ${dependency}`);
        }
    }
    if (missing.length) throw new Error(`Fallback bundle omits required local assets:\n${missing.join('\n')}\nUpdate the bundle patterns before releasing.`);
    return { checkedFiles: files.filter(included).length };
}
module.exports = { checkFallbackDependencies, findReferences, matchesPattern };
