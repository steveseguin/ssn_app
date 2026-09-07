'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkFallbackDependencies } = require('../../scripts/check-fallback-dependencies');
const { getSocialStreamSourceUrls } = require('../../resources/social-stream-source-mirrors');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-dependency-guard-'));
try {
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    fs.mkdirSync(path.join(root, 'thirdparty'));
    fs.mkdirSync(path.join(root, 'js'));
    fs.writeFileSync(path.join(root, 'index.html'), '<script src="./js/loader.js"></script>');
    fs.writeFileSync(path.join(root, 'js/loader.js'), 'const scripts = ["../thirdparty/new-library.js?v=1"];');
    fs.writeFileSync(path.join(root, 'thirdparty/new-library.js'), 'window.library = true;');
    assert.throws(() => checkFallbackDependencies(root, ['/*.html', '/js/**']), /loader.js -> thirdparty\/new-library.js/);
    checkFallbackDependencies(root, ['/*.html', '/js/**', '/thirdparty/new-library.js']);
    // A sparse checkout must still flag a tracked dependency that is not present on disk.
    execFileSync('git', ['-C', root, 'add', '.']);
    fs.unlinkSync(path.join(root, 'thirdparty/new-library.js'));
    assert.throws(() => checkFallbackDependencies(root, ['/*.html', '/js/**']), /new-library.js/);
    assert.throws(() => checkFallbackDependencies(root, ['/*.html', '/js/**', '/thirdparty/**']), /Bundled source is missing/);
    const canonical = 'https://raw.githubusercontent.com/steveseguin/social_stream/beta/sources/youtube.js';
    assert.deepStrictEqual(getSocialStreamSourceUrls(canonical), [
        'https://cache.socialstream.ninja/beta/sources/youtube.js',
        'https://beta.socialstream.ninja/sources/youtube.js', canonical,
    ]);
    for (const custom of ['https://example.com/sources/youtube.js', 'https://raw.githubusercontent.com/other/repo/main/sources/youtube.js']) {
        assert.deepStrictEqual(getSocialStreamSourceUrls(custom), [custom]);
    }
    console.log('PASS dependency omission, transitive loader, sparse checkout, missing file, and source URL isolation checks.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
