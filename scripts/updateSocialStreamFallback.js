const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_URL = process.env.SSN_SOCIALSTREAM_REPO || 'https://github.com/steveseguin/social_stream.git';
const BRANCH = process.env.SSN_SOCIALSTREAM_BRANCH || 'main';
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
    '/icons/**',
    '/js/**',
    '/libs/**',
    '/media/**',
    '/providers/**',
    '/settings/**',
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

function updateFallback() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssn-socialstream-'));
    const cloneDir = path.join(tmpRoot, 'social_stream');
    const fallbackRoot = path.join(__dirname, '..', 'resources', 'social_stream_fallback', BRANCH);

    const sparsePatterns = normalizePatterns(BASE_PATTERNS, EXTRA_PATTERNS);
    if (!sparsePatterns.length) {
        console.error('[fallback] No sparse-checkout patterns defined. Aborting.');
        process.exit(1);
    }
    if (INCLUDE_TTS) {
        sparsePatterns.push(...TTS_PATTERNS);
    }

    try {
        console.log(`[fallback] Cloning ${REPO_URL}#${BRANCH} with sparse checkout ...`);
        runGit(['clone', '--filter=blob:none', '--sparse', '--branch', BRANCH, REPO_URL, cloneDir]);

        console.log('[fallback] Configuring sparse-checkout allowlist...');
        runGit(['-C', cloneDir, 'sparse-checkout', 'init', '--no-cone']);
        runGit(['-C', cloneDir, 'sparse-checkout', 'set', ...sparsePatterns]);

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

        console.log(`[fallback] Updating bundle at ${fallbackRoot}`);
        fs.removeSync(fallbackRoot);
        fs.ensureDirSync(fallbackRoot);
        fs.copySync(cloneDir, fallbackRoot, {
            dereference: true,
            filter: (src) => {
                const rel = path.relative(cloneDir, src);
                if (!rel || rel === '') return true;
                return !rel.split(path.sep).includes('.git');
            }
        });
        console.log('[fallback] Bundle update complete.');
    } catch (error) {
        console.error('[fallback] Failed to update Social Stream fallback bundle:', error && error.message ? error.message : error);
        process.exit(1);
    } finally {
        try {
            fs.removeSync(tmpRoot);
        } catch (cleanupError) {
            console.warn('[fallback] Failed to clean temporary directory:', cleanupError && cleanupError.message ? cleanupError.message : cleanupError);
        }
    }
}

updateFallback();
