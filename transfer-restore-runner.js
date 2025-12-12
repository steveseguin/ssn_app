/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const { extractTransferBackup, readTransferBackupHeader } = require('./transfer-backup');

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid, timeoutMs = 120000) {
    if (!pid || !Number.isFinite(pid)) return;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            if (error && error.code === 'ESRCH') {
                return;
            }
        }
        await sleep(250);
    }
    throw new Error(`Timed out waiting for PID ${pid} to exit`);
}

function makeLogger(logPath) {
    return (line) => {
        try {
            fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
        } catch (_) { }
    };
}

async function renameWithRetries(fromPath, toPath, attempts = 20, delayMs = 500) {
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
        try {
            await fsp.rename(fromPath, toPath);
            return;
        } catch (error) {
            lastError = error;
            await sleep(delayMs);
        }
    }
    throw lastError || new Error(`Failed to rename ${fromPath} to ${toPath}`);
}

async function main() {
    const config = await readStdinJson();
    const backupFilePath = String(config.backupFilePath || '').trim();
    const password = config.password;
    const userDataDir = path.resolve(String(config.userDataDir || '').trim());
    const parentPid = Number(config.parentPid);
    const execPath = String(config.execPath || '').trim();
    const appArgs = Array.isArray(config.appArgs) ? config.appArgs.map(String) : [];
    const logPath = config.logPath
        ? path.resolve(String(config.logPath))
        : path.join(path.dirname(backupFilePath), `transfer-restore-${Date.now()}.log`);

    const log = makeLogger(logPath);
    log(`Starting restore runner. userDataDir=${userDataDir}`);

    if (!backupFilePath || !fs.existsSync(backupFilePath)) {
        throw new Error('Backup file not found');
    }
    if (!password) {
        throw new Error('Password is required');
    }
    if (!userDataDir) {
        throw new Error('userDataDir is required');
    }

    const headerInfo = await readTransferBackupHeader(backupFilePath);
    log(`Backup header loaded. createdAt=${headerInfo?.header?.createdAt || 'unknown'}`);

    await waitForPidExit(parentPid);
    log(`Parent PID ${parentPid} exited`);

    const parentDir = path.dirname(userDataDir);
    const restoreTmpDir = path.join(parentDir, `${path.basename(userDataDir)}.restore-tmp-${Date.now()}`);
    const oldBackupDir = path.join(parentDir, `${path.basename(userDataDir)}.pre-restore-${Date.now()}`);

    await fsp.rm(restoreTmpDir, { recursive: true, force: true });
    await fsp.mkdir(restoreTmpDir, { recursive: true });

    log(`Extracting backup to ${restoreTmpDir}`);
    await extractTransferBackup({
        backupFilePath,
        password,
        outputDir: restoreTmpDir
    });

    log('Extraction complete; swapping directories');

    if (fs.existsSync(userDataDir)) {
        await renameWithRetries(userDataDir, oldBackupDir, 30, 500);
        log(`Moved existing userData to ${oldBackupDir}`);
    }

    try {
        await renameWithRetries(restoreTmpDir, userDataDir, 10, 500);
        log(`Restored userData to ${userDataDir}`);
    } catch (error) {
        log(`Failed to move restored directory into place: ${error && error.message ? error.message : String(error)}`);
        try {
            if (fs.existsSync(oldBackupDir)) {
                await renameWithRetries(oldBackupDir, userDataDir, 10, 500);
                log('Rolled back to previous userData');
            }
        } catch (rollbackError) {
            log(`Rollback failed: ${rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError)}`);
        }
        throw error;
    }

    log('Relaunching application');
    if (execPath) {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(execPath, appArgs, { detached: true, stdio: 'ignore', env });
        child.unref();
    } else {
        log('No execPath provided; not relaunching');
    }

    process.stdout.write(`${JSON.stringify({ success: true, logPath })}\n`);
}

main().catch((error) => {
    try {
        process.stderr.write(`[TransferRestoreRunner] ${error && error.stack ? error.stack : String(error)}\n`);
    } catch (_) { }
    process.exitCode = 1;
});

