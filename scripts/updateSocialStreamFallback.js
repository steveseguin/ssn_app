const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_URL = process.env.SSN_SOCIALSTREAM_REPO || 'https://github.com/steveseguin/social_stream.git';
const BRANCH = process.env.SSN_SOCIALSTREAM_BRANCH || 'main';
const OUTPUT_BRANCH = process.env.SSN_SOCIALSTREAM_OUTPUT_BRANCH || BRANCH;
const LOCAL_SOURCE = String(process.env.SSN_SOCIALSTREAM_SOURCE || '').trim();
const INCLUDE_TTS = /^true$/i.test(process.env.SSN_INCLUDE_TTS || '');
const EXTRA_PATTERNS = (process.env.SSN_FALLBACK_EXTRA || '')
    .split(/[,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);

const BASE_PATTERNS = [
    '/*.html',
    '/*.js',
    '/*.json',
    '/*.ico',
    '/*.png',
    '/*.svg',
    '/*.css',
    '/*.md',
    '/*.txt',
    '/actions/**',
    '/audio/**',
    '/icons/**',
    '/js/**',
    '/libs/**',
    '/media/**',
    '/docs/**',
    '/providers/**',
    '/settings/**',
    '/shared/**',
    '/sources/**',
    '/translations/**',
    '/thirdparty/NotoColorEmoji.ttf',
    '/thirdparty/NotoColorEmoji.full.ttf',
    '/thirdparty/xMQbuFFYT72XzQspDre2.woff2',
    '/thirdparty/xMQbuFFYT72XzQUpDg.woff2',
    '/thirdparty/webmidi3.js',
    '/thirdparty/sentiment.js',
    '/thirdparty/lunr.js',
    '/thirdparty/xlsx.full.min.js',
    '/thirdparty/d3.min.js',
    '/thirdparty/obs-websocket.min.js',
    '/thirdparty/StreamSaver.js',
    '/thirdparty/vdoninja-sdk.js',
    '/thirdparty/pubnub.min.js',
    '/thirdparty/animate.css',
    '/thirdparty/buttons.js',
    '/thirdparty/index.umd.min.js',
    '/thirdparty/marked.umd.min.js',
    '/thirdparty/mitm.html'
];

const TTS_PATTERNS = [
    '/thirdparty/espeak-ng-real.js',
    '/thirdparty/espeakng-simple.js',
    '/thirdparty/espeakng.worker.js',
    '/thirdparty/espeakng.worker.data',
    '/thirdparty/group*',
    '/thirdparty/kitten-tts/**',
    '/thirdparty/kitten_tts_nano_v0_1.onnx',
    '/thirdparty/kokoro-bundle.es.js',
    '/thirdparty/kokoro-bundle.es.ext.js',
    '/thirdparty/kokoro-ort-wasm.wasm',
    '/thirdparty/kokoro-ort-wasm-simd.wasm',
    '/thirdparty/kokoro-ort-wasm-simd-threaded.jsep.wasm',
    '/thirdparty/onnxruntime-web.js',
    '/thirdparty/ort.min.js',
    '/thirdparty/ort-wasm.wasm',
    '/thirdparty/ort-wasm-simd.wasm',
    '/thirdparty/ort-wasm-simd-threaded.jsep.mjs',
    '/thirdparty/ort-wasm-simd-threaded.jsep.wasm',
    '/thirdparty/piper/**',
    '/thirdparty/tf.min.js'
];

function runGit(args) {
    execFileSync('git', args, { stdio: 'inherit' });
}

function normalizePatterns(basePatterns, extraPatterns) {
    const normalized = [...basePatterns];
    for (const pattern of extraPatterns) {
        if (!pattern) continue;
        normalized.push(pattern.startsWith('/') ? pattern : `/${pattern}`);
    }
    return normalized;
}

function globToRegExp(pattern) {
    const normalized = String(pattern || '').replace(/^\/+/, '').replace(/\\/g, '/');
    let expression = '^';
    for (let index = 0; index < normalized.length; index += 1) {
        const character = normalized[index];
        if (character === '*') {
            if (normalized[index + 1] === '*') {
                expression += '.*';
                index += 1;
            } else {
                expression += '[^/]*';
            }
        } else if (character === '?') {
            expression += '[^/]';
        } else {
            expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        }
    }
    return new RegExp(`${expression}$`);
}

function copyLocalFallback(sourceRoot, fallbackRoot, sparsePatterns) {
    const matchers = sparsePatterns.map(globToRegExp);
    let copiedFiles = 0;

    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            const absolutePath = path.join(directory, entry.name);
            const relativePath = path.relative(sourceRoot, absolutePath).split(path.sep).join('/');
            if (entry.isDirectory()) {
                visit(absolutePath);
                continue;
            }
            if (!entry.isFile() && !entry.isSymbolicLink()) continue;
            if (!matchers.some((matcher) => matcher.test(relativePath))) continue;
            const destination = path.join(fallbackRoot, relativePath);
            fs.ensureDirSync(path.dirname(destination));
            fs.copySync(absolutePath, destination, { dereference: true });
            copiedFiles += 1;
        }
    }

    visit(sourceRoot);
    return copiedFiles;
}

function updateFallback() {
    let tmpRoot = null;
    let sourceRoot = null;
    const fallbackRoot = path.join(__dirname, '..', 'resources', 'social_stream_fallback', OUTPUT_BRANCH);

    const sparsePatterns = normalizePatterns(BASE_PATTERNS, EXTRA_PATTERNS);
    if (!sparsePatterns.length) {
        console.error('[fallback] No sparse-checkout patterns defined. Aborting.');
        process.exit(1);
    }
    if (INCLUDE_TTS) {
        sparsePatterns.push(...TTS_PATTERNS);
    }

    try {
        if (LOCAL_SOURCE) {
            sourceRoot = path.resolve(LOCAL_SOURCE);
            if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
                throw new Error(`SSN_SOCIALSTREAM_SOURCE is not a directory: ${sourceRoot}`);
            }
            console.log(`[fallback] Using local Social Stream source at ${sourceRoot}`);
        } else {
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssn-socialstream-'));
            sourceRoot = path.join(tmpRoot, 'social_stream');
            console.log(`[fallback] Cloning ${REPO_URL}#${BRANCH} with sparse checkout ...`);
            runGit(['clone', '--filter=blob:none', '--sparse', '--branch', BRANCH, REPO_URL, sourceRoot]);

            console.log('[fallback] Configuring sparse-checkout allowlist...');
            runGit(['-C', sourceRoot, 'sparse-checkout', 'init', '--no-cone']);
            runGit(['-C', sourceRoot, 'sparse-checkout', 'set', ...sparsePatterns]);
        }

        console.log('[fallback] Included patterns:');
        for (const pattern of sparsePatterns) {
            console.log(`  - ${pattern}`);
        }

        if (INCLUDE_TTS) {
            console.log('[fallback] TTS assets included (SSN_INCLUDE_TTS=true).');
        } else {
            console.log('[fallback] Skipping large TTS assets. Set SSN_INCLUDE_TTS=true to bundle them.');
        }
        if (EXTRA_PATTERNS.length) {
            console.log(`[fallback] Extra patterns requested: ${EXTRA_PATTERNS.join(', ')}`);
        }

        console.log(`[fallback] Updating ${OUTPUT_BRANCH} source bundle at ${fallbackRoot}`);
        fs.removeSync(fallbackRoot);
        fs.ensureDirSync(fallbackRoot);
        if (LOCAL_SOURCE) {
            const copiedFiles = copyLocalFallback(sourceRoot, fallbackRoot, sparsePatterns);
            if (!copiedFiles) throw new Error('No files matched the fallback allowlist in the local source.');
            console.log(`[fallback] Copied ${copiedFiles} allowlisted files from the local source.`);
        } else {
            fs.copySync(sourceRoot, fallbackRoot, {
                dereference: true,
                filter: (src) => {
                    const rel = path.relative(sourceRoot, src);
                    if (!rel || rel === '') return true;
                    return !rel.split(path.sep).includes('.git');
                }
            });
        }
        console.log('[fallback] Bundle update complete.');
    } catch (error) {
        console.error('[fallback] Failed to update Social Stream fallback bundle:', error && error.message ? error.message : error);
        process.exit(1);
    } finally {
        if (tmpRoot) {
            try {
                fs.removeSync(tmpRoot);
            } catch (cleanupError) {
                console.warn('[fallback] Failed to clean temporary directory:', cleanupError && cleanupError.message ? cleanupError.message : cleanupError);
            }
        }
    }
}

updateFallback();
