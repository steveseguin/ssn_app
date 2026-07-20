import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFilePromise = promisify(execFile);

export default async function (params) {
    // Only notarize the app on Mac OS only.
    if (process.platform !== 'darwin') {
        return;
    }
    console.log('afterSign hook triggered', params);
    
    const appId = params.packager.config.appId || 'socialstream.electron';
    const appPath = path.join(params.appOutDir, `${params.packager.appInfo.productFilename}.app`);
    
    try {
        await fs.access(appPath);
    } catch {
        throw new Error(`Cannot find application at: ${appPath}`);
    }
    
    console.log(`Notarizing ${appId} found at ${appPath}`);
    
    const keychainProfile = process.env.notarytoolProfile || process.env.NOTARYTOOL_KEYCHAIN_PROFILE || process.env.APPLE_NOTARY_KEYCHAIN_PROFILE;
    const appleId = process.env.APPLE_ID || process.env.appleId;
    const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.appleIdPassword;
    const teamId = process.env.APPLE_TEAM_ID || process.env.teamId;
    const configuredCredentialCount = [appleId, appleIdPassword, teamId].filter(Boolean).length;

    // Skip notarization if credentials are not available
    if (!keychainProfile && configuredCredentialCount === 0) {
        console.log('Skipping notarization due to missing credentials');
        return;
    }

    if (!keychainProfile && configuredCredentialCount !== 3) {
        const missing = [];
        if (!appleId) missing.push('APPLE_ID');
        if (!appleIdPassword) missing.push('APPLE_APP_SPECIFIC_PASSWORD');
        if (!teamId) missing.push('APPLE_TEAM_ID');
        throw new Error(`Cannot notarize because these environment variables are missing: ${missing.join(', ')}`);
    }
    
    try {
        // Create a zip file of the app
        const zipPath = `${appPath}.zip`;
        console.log(`Creating zip at ${zipPath}`);
        await execFilePromise('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
        
        const profileName = keychainProfile || `electron-notarize-${Date.now()}`;

        if (keychainProfile) {
            console.log(`Using existing keychain profile: ${profileName}`);
        } else {
            console.log(`Storing credentials in keychain profile: ${profileName}`);

            // Store credentials in keychain
            await execFilePromise('xcrun', [
                'notarytool', 'store-credentials', profileName,
                '--apple-id', appleId,
                '--team-id', teamId,
                '--password', appleIdPassword
            ]);
        }
        
        // Submit for notarization using the keychain profile
        console.log('Submitting for notarization...');
        const { stdout } = await execFilePromise('xcrun', [
            'notarytool', 'submit', zipPath,
            '--keychain-profile', profileName,
            '--wait'
        ]);
        
        console.log(`Notarization output: ${stdout}`);
        
        // Staple the ticket to the app
        if (stdout.includes('status: Accepted')) {
            console.log('Stapling notarization ticket...');
            await execFilePromise('xcrun', ['stapler', 'staple', appPath]);
            console.log('Successfully stapled notarization ticket');
        } else {
            throw new Error(`Notarization failed: ${stdout}`);
        }
        
        // Clean up
        await fs.unlink(zipPath).catch(() => {});
        
        // We'll skip the keychain profile deletion as it's not necessary
        // and the command format appears to be unsupported
        
    } catch (error) {
        console.error('Notarization error:', error);
        throw error;
    }
    
    console.log(`Done notarizing ${appId}`);
}
