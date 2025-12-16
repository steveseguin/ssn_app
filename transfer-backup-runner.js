/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

function bootstrapNodeModulePaths() {
    try {
        const candidates = [
            path.join(__dirname, 'node_modules'),
            path.join(process.cwd(), 'node_modules')
        ];

        if (process.resourcesPath) {
            candidates.push(
                path.join(process.resourcesPath, 'app.asar', 'node_modules'),
                path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
            );
        }

        if (process.execPath) {
            const execDir = path.dirname(process.execPath);
            candidates.push(
                path.join(execDir, 'resources', 'app.asar', 'node_modules'),
                path.join(execDir, 'resources', 'app.asar.unpacked', 'node_modules'),
                path.join(execDir, '..', 'Resources', 'app.asar', 'node_modules'),
                path.join(execDir, '..', 'Resources', 'app.asar.unpacked', 'node_modules')
            );
        }

        const existing = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
        const next = new Set(existing);

        for (const candidate of candidates) {
            if (!candidate) continue;
            try {
                if (fs.existsSync(candidate)) {
                    next.add(candidate);
                }
            } catch (_) { }
        }

        const joined = Array.from(next).join(path.delimiter);
        if (joined !== (process.env.NODE_PATH || '')) {
            process.env.NODE_PATH = joined;
            if (typeof Module._initPaths === 'function') {
                Module._initPaths();
            }
        }
    } catch (_) { }
}

bootstrapNodeModulePaths();

const { createTransferBackup } = require('./transfer-backup');

function readStdinJson() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => {
            try {
                resolve(JSON.parse(data || '{}'));
            } catch (error) {
                reject(error);
            }
        });
        process.stdin.on('error', reject);
    });
}

function writeJsonLine(value) {
    try {
        process.stdout.write(`${JSON.stringify(value)}\n`);
    } catch (_) { }
}

async function main() {
    const config = await readStdinJson();
    const progressThrottleMs = 250;
    let lastProgressAt = 0;

    const result = await createTransferBackup({
        ...config,
        onProgress(payload) {
            try {
                const now = Date.now();
                if (now - lastProgressAt < progressThrottleMs) return;
                lastProgressAt = now;

                const progress = payload && typeof payload === 'object' ? payload.progress : null;
                const entries = progress && typeof progress === 'object' ? progress.entries : null;
                const fsInfo = progress && typeof progress === 'object' ? progress.fs : null;

                const entriesProcessed = Number(entries?.processed) || 0;
                const entriesTotal = Number(entries?.total) || 0;
                const bytesProcessed = Number(fsInfo?.processedBytes) || 0;
                const bytesTotal = Number(fsInfo?.totalBytes) || 0;
                const percent = bytesTotal > 0 ? Math.min(1, bytesProcessed / bytesTotal) : null;

                writeJsonLine({
                    type: 'progress',
                    phase: payload.phase || null,
                    entriesProcessed,
                    entriesTotal,
                    bytesProcessed,
                    bytesTotal,
                    percent
                });
            } catch (_) { }
        }
    });

    process.stdout.write(`${JSON.stringify({ success: true, result })}\n`);
}

main().catch((error) => {
    try {
        process.stderr.write(`[TransferBackupRunner] ${error && error.stack ? error.stack : String(error)}\n`);
    } catch (_) { }
    try {
        process.stdout.write(`${JSON.stringify({ success: false, error: error && error.message ? error.message : String(error) })}\n`);
    } catch (_) { }
    process.exitCode = 1;
});
