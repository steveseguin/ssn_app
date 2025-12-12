/* eslint-disable no-console */
'use strict';

const fs = require('fs');

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

async function main() {
    const config = await readStdinJson();
    const result = await createTransferBackup(config);
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

