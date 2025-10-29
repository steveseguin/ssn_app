const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const REPO_URL = process.env.SSN_SOCIALSTREAM_REPO || 'https://github.com/steveseguin/social_stream.git';
const BRANCH = process.env.SSN_SOCIALSTREAM_BRANCH || 'main';

function updateFallback() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssn-socialstream-'));
    const cloneDir = path.join(tmpRoot, 'social_stream');
    const fallbackRoot = path.join(__dirname, '..', 'resources', 'social_stream_fallback', BRANCH);

    try {
        console.log(`[fallback] Cloning ${REPO_URL}#${BRANCH} ...`);
        execSync(`git clone --depth=1 --branch ${BRANCH} ${REPO_URL} "${cloneDir}"`, { stdio: 'inherit' });

        console.log(`[fallback] Updating bundle at ${fallbackRoot}`);
        fs.removeSync(fallbackRoot);
        fs.ensureDirSync(fallbackRoot);
        fs.copySync(cloneDir, fallbackRoot, { dereference: true });
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
