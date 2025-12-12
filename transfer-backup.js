/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('node:crypto');
const { PassThrough } = require('stream');
const { pipeline } = require('stream/promises');

let archiver;
let unzipper;

const FILE_MAGIC = Buffer.from('SSAPPBK1', 'ascii'); // 7 bytes
const FILE_VERSION = 1;
const AUTH_TAG_LENGTH = 16;

function requireArchiver() {
    if (!archiver) {
        archiver = require('archiver');
    }
    return archiver;
}

function requireUnzipper() {
    if (!unzipper) {
        unzipper = require('unzipper');
    }
    return unzipper;
}

function toB64(buffer) {
    return Buffer.from(buffer).toString('base64');
}

function fromB64(text) {
    return Buffer.from(text, 'base64');
}

function normalizeDirectoryPath(input) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('Path is required');
    }
    return path.resolve(input);
}

function isSubPath(childPath, parentPath) {
    const resolvedChild = path.resolve(childPath);
    const resolvedParent = path.resolve(parentPath);
    if (resolvedChild === resolvedParent) return true;
    const prefix = resolvedParent.endsWith(path.sep) ? resolvedParent : `${resolvedParent}${path.sep}`;
    return resolvedChild.startsWith(prefix);
}

function createUInt32BE(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value >>> 0, 0);
    return buf;
}

function getDefaultIgnoreGlobs({ includeCaches = false } = {}) {
    const ignore = [
        '**/SingletonLock',
        '**/SingletonSocket',
        '**/SingletonCookie',
        '**/DevTools Active Port'
    ];

    if (!includeCaches) {
        ignore.push(
            '**/Cache/**',
            '**/Code Cache/**',
            '**/GPUCache/**',
            '**/DawnCache/**',
            '**/ShaderCache/**',
            '**/GrShaderCache/**',
            '**/Crashpad/**'
        );
    }

    return ignore;
}

function resolveSafeExtractPath(baseDir, entryPath) {
    const base = path.resolve(baseDir);
    const normalized = String(entryPath || '')
        .replace(/\\/g, '/')
        .replace(/^[A-Za-z]:\//, '');

    const parts = normalized.split('/').filter((part) => part && part !== '.' && part !== '..');
    const safeRelative = parts.join(path.sep);
    const resolved = path.resolve(base, safeRelative);
    const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;

    if (resolved !== base && !resolved.startsWith(prefix)) {
        throw new Error(`Refusing to extract outside destination: ${entryPath}`);
    }

    return resolved;
}

function deriveKeyScrypt(password, salt, options) {
    const params = options || {};
    const keyLen = params.keyLen || 32;
    const scryptOpts = {
        N: params.N || 32768,
        r: params.r || 8,
        p: params.p || 1,
        maxmem: params.maxmem || 128 * 1024 * 1024
    };
    return crypto.scryptSync(String(password), salt, keyLen, scryptOpts);
}

async function writeFileAtomic(targetPath, writeFn) {
    const dir = path.dirname(targetPath);
    await fsp.mkdir(dir, { recursive: true });

    const tmpPath = `${targetPath}.tmp`;
    const bakPath = `${targetPath}.bak`;

    await fsp.rm(tmpPath, { force: true });

    try {
        await writeFn(tmpPath);

        try {
            await fsp.rm(bakPath, { force: true });
        } catch (_) { }

        try {
            await fsp.rename(targetPath, bakPath);
        } catch (_) { }

        await fsp.rename(tmpPath, targetPath);
        return { tmpPath, bakPath };
    } catch (error) {
        try {
            await fsp.rm(tmpPath, { force: true });
        } catch (_) { }
        throw error;
    }
}

async function createTransferBackup({
    userDataDir,
    outputFilePath,
    password,
    includeCaches = false,
    compressionLevel = 1,
    appName = null,
    appVersion = null,
    scrypt = null
}) {
    const resolvedUserData = normalizeDirectoryPath(userDataDir);
    const resolvedOutput = path.resolve(outputFilePath);

    if (!password) {
        throw new Error('Password is required');
    }

    if (isSubPath(resolvedOutput, resolvedUserData)) {
        throw new Error('Backup output must not be inside the userData directory');
    }

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const kdfParams = {
        keyLen: 32,
        N: scrypt?.N || 32768,
        r: scrypt?.r || 8,
        p: scrypt?.p || 1,
        maxmem: scrypt?.maxmem || 128 * 1024 * 1024
    };

    const key = deriveKeyScrypt(password, salt, kdfParams);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const header = {
        format: 'ssapp-transfer-backup',
        version: FILE_VERSION,
        createdAt: new Date().toISOString(),
        app: {
            name: appName || null,
            version: appVersion || null
        },
        archive: {
            type: 'zip',
            compressionLevel,
            includeCaches
        },
        kdf: {
            name: 'scrypt',
            salt: toB64(salt),
            N: kdfParams.N,
            r: kdfParams.r,
            p: kdfParams.p,
            keyLen: kdfParams.keyLen
        },
        cipher: {
            name: 'aes-256-gcm',
            iv: toB64(iv),
            tagLen: AUTH_TAG_LENGTH
        }
    };

    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
    const prefixBuf = Buffer.concat([
        FILE_MAGIC,
        Buffer.from([FILE_VERSION]),
        createUInt32BE(headerBuf.length),
        headerBuf
    ]);

    const ignore = getDefaultIgnoreGlobs({ includeCaches });
    const Archiver = requireArchiver();

    const startedAt = Date.now();

    await writeFileAtomic(resolvedOutput, async (tmpPath) => {
        const out = fs.createWriteStream(tmpPath, { flags: 'wx' });
        const encrypted = new PassThrough();

        out.write(prefixBuf);

        encrypted.pipe(out, { end: false });

        const archive = Archiver('zip', { zlib: { level: compressionLevel } });
        archive.on('warning', (err) => {
            if (err && err.code !== 'ENOENT') {
                console.warn('[TransferBackup] archiver warning:', err);
            }
        });

        const pipelinePromise = pipeline(archive, cipher, encrypted);

        archive.glob('**/*', {
            cwd: resolvedUserData,
            dot: true,
            follow: false,
            ignore
        });

        const finalizeResult = archive.finalize();
        if (finalizeResult && typeof finalizeResult.then === 'function') {
            await finalizeResult;
        }

        await pipelinePromise;

        const authTag = cipher.getAuthTag();
        await new Promise((resolve, reject) => {
            out.write(authTag, (err) => (err ? reject(err) : resolve()));
        });
        out.end();
        await new Promise((resolve, reject) => {
            out.on('finish', resolve);
            out.on('error', reject);
        });
    });

    const endedAt = Date.now();
    const stats = await fsp.stat(resolvedOutput);
    return {
        filePath: resolvedOutput,
        bytes: stats.size,
        startedAt,
        endedAt,
        header
    };
}

async function readTransferBackupHeader(backupFilePath) {
    const filePath = path.resolve(backupFilePath);
    const fd = await fsp.open(filePath, 'r');
    try {
        const prefixLen = FILE_MAGIC.length + 1 + 4;
        const prefix = Buffer.alloc(prefixLen);
        const { bytesRead } = await fd.read(prefix, 0, prefixLen, 0);
        if (bytesRead !== prefixLen) {
            throw new Error('Backup file too small');
        }

        const magic = prefix.subarray(0, FILE_MAGIC.length);
        if (!magic.equals(FILE_MAGIC)) {
            throw new Error('Invalid backup file (bad magic)');
        }

        const version = prefix.readUInt8(FILE_MAGIC.length);
        if (version !== FILE_VERSION) {
            throw new Error(`Unsupported backup version: ${version}`);
        }

        const headerLen = prefix.readUInt32BE(FILE_MAGIC.length + 1);
        if (!headerLen || headerLen > 10 * 1024 * 1024) {
            throw new Error('Invalid backup header length');
        }

        const headerBuf = Buffer.alloc(headerLen);
        const headerOffset = prefixLen;
        const headerRead = await fd.read(headerBuf, 0, headerLen, headerOffset);
        if (headerRead.bytesRead !== headerLen) {
            throw new Error('Truncated backup header');
        }

        const header = JSON.parse(headerBuf.toString('utf8'));
        const payloadOffset = headerOffset + headerLen;

        const stats = await fd.stat();
        if (stats.size < payloadOffset + AUTH_TAG_LENGTH) {
            throw new Error('Backup file missing payload');
        }

        return {
            filePath,
            header,
            payloadOffset,
            fileSize: stats.size
        };
    } finally {
        await fd.close();
    }
}

async function extractTransferBackup({
    backupFilePath,
    password,
    outputDir
}) {
    if (!password) {
        throw new Error('Password is required');
    }

    const resolvedOutputDir = normalizeDirectoryPath(outputDir);
    const { header, payloadOffset, fileSize } = await readTransferBackupHeader(backupFilePath);

    if (!header || header.format !== 'ssapp-transfer-backup') {
        throw new Error('Invalid backup header');
    }
    if (!header.kdf || header.kdf.name !== 'scrypt') {
        throw new Error('Unsupported key derivation');
    }
    if (!header.cipher || header.cipher.name !== 'aes-256-gcm') {
        throw new Error('Unsupported cipher');
    }

    const tagLen = header.cipher.tagLen || AUTH_TAG_LENGTH;
    if (tagLen !== AUTH_TAG_LENGTH) {
        throw new Error(`Unsupported auth tag length: ${tagLen}`);
    }

    const salt = fromB64(header.kdf.salt);
    const iv = fromB64(header.cipher.iv);
    const key = deriveKeyScrypt(password, salt, {
        keyLen: header.kdf.keyLen || 32,
        N: header.kdf.N,
        r: header.kdf.r,
        p: header.kdf.p
    });

    const fd = await fsp.open(path.resolve(backupFilePath), 'r');
    try {
        const authTag = Buffer.alloc(AUTH_TAG_LENGTH);
        await fd.read(authTag, 0, AUTH_TAG_LENGTH, fileSize - AUTH_TAG_LENGTH);

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        const zipEnd = fileSize - AUTH_TAG_LENGTH - 1;
        const zipStream = fs.createReadStream(path.resolve(backupFilePath), {
            start: payloadOffset,
            end: zipEnd
        });

        await fsp.mkdir(resolvedOutputDir, { recursive: true });

        const Unzipper = requireUnzipper();
        const parser = Unzipper.Parse();

        let chain = Promise.resolve();
        let failed = false;

        const processEntry = async (entry) => {
            if (failed) {
                entry.autodrain();
                return;
            }

            const rawEntryPath = entry.path || entry.props?.path || entry.fileName || '';
            const destinationPath = resolveSafeExtractPath(resolvedOutputDir, rawEntryPath);

            if (entry.type === 'Directory') {
                await fsp.mkdir(destinationPath, { recursive: true });
                entry.autodrain();
                return;
            }

            if (entry.type !== 'File') {
                entry.autodrain();
                return;
            }

            await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
            await pipeline(entry, fs.createWriteStream(destinationPath));
        };

        await new Promise((resolve, reject) => {
            const abort = (error) => {
                if (failed) return;
                failed = true;
                try {
                    parser.destroy(error);
                } catch (_) { }
                reject(error);
            };

            parser.on('entry', (entry) => {
                chain = chain.then(() => processEntry(entry)).catch(abort);
            });
            parser.on('error', abort);
            parser.on('close', () => {
                chain.then(resolve).catch(reject);
            });

            zipStream.on('error', abort);
            decipher.on('error', abort);
            zipStream.pipe(decipher).pipe(parser).on('error', abort);
        });

        return { header };
    } catch (error) {
        try {
            await fsp.rm(resolvedOutputDir, { recursive: true, force: true });
        } catch (_) { }
        throw error;
    } finally {
        await fd.close();
    }
}

module.exports = {
    FILE_MAGIC: FILE_MAGIC.toString('ascii'),
    FILE_VERSION,
    AUTH_TAG_LENGTH,
    getDefaultIgnoreGlobs,
    readTransferBackupHeader,
    createTransferBackup,
    extractTransferBackup
};
