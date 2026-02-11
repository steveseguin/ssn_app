'use strict';

const fs = require('fs');
const path = require('path');

function readText(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

function exists(filePath) {
	try {
		return fs.existsSync(filePath);
	} catch (_) {
		return false;
	}
}

function existsWithExactCase(filePath) {
	try {
		const dir = path.dirname(filePath);
		const base = path.basename(filePath);
		if (!fs.existsSync(dir)) return false;
		const names = fs.readdirSync(dir);
		return names.includes(base);
	} catch (_) {
		return false;
	}
}

function parseJson(filePath) {
	try {
		return JSON.parse(readText(filePath));
	} catch (_) {
		return null;
	}
}

function findDataDir() {
	const candidates = [];
	if (process.env.APPDATA) {
		candidates.push(path.join(process.env.APPDATA, 'socialstream'));
	}
	if (process.env.HOME) {
		candidates.push(path.join(process.env.HOME, 'AppData', 'Roaming', 'socialstream'));
	}
	candidates.push(path.join('/mnt', 'c', 'Users', 'steve', 'AppData', 'Roaming', 'socialstream'));
	for (const candidate of candidates) {
		if (exists(candidate)) return candidate;
	}
	return null;
}

function getCoreRoot() {
	if (process.env.SOCIAL_STREAM_CORE_PATH && exists(process.env.SOCIAL_STREAM_CORE_PATH)) {
		return process.env.SOCIAL_STREAM_CORE_PATH;
	}
	const localSibling = path.resolve(__dirname, '..', '..', '..', 'social_stream');
	if (exists(localSibling)) return localSibling;
	const winPath = path.join('/mnt', 'c', 'Users', 'steve', 'Code', 'social_stream');
	if (exists(winPath)) return winPath;
	return null;
}

function lineContains(filePath, pattern) {
	const text = readText(filePath);
	return pattern.test(text);
}

function settingsKeyCount(obj) {
	if (!obj || typeof obj !== 'object') return 0;
	return Object.keys(obj).length;
}

function parseEmbeddedSettingsFromConfig(configJson) {
	const raw = configJson && configJson.localStorageBackup && configJson.localStorageBackup.settings;
	if (!raw) return null;
	if (typeof raw === 'object') return raw;
	if (typeof raw !== 'string') return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch (_) {
		return null;
	}
}

function run() {
	const repoRoot = path.resolve(__dirname, '..', '..');
	const indexPath = path.join(repoRoot, 'index.html');
	const mainPath = path.join(repoRoot, 'main.js');
	const fallbackPopupPath = path.join(repoRoot, 'resources', 'social_stream_fallback', 'main', 'popup.js');
	const fallbackBackgroundPath = path.join(repoRoot, 'resources', 'social_stream_fallback', 'main', 'background.js');
	const fallbackPopupHtmlPath = path.join(repoRoot, 'resources', 'social_stream_fallback', 'main', 'popup.html');
	const fallbackSocialStreamPng = path.join(repoRoot, 'resources', 'social_stream_fallback', 'main', 'sources', 'images', 'socialstream.png');
	const fallbackVdoSdk = path.join(repoRoot, 'resources', 'social_stream_fallback', 'main', 'thirdparty', 'vdoninja-sdk.js');

	const coreRoot = getCoreRoot();
	const corePopupPath = coreRoot ? path.join(coreRoot, 'popup.js') : null;
	const coreBackgroundPath = coreRoot ? path.join(coreRoot, 'background.js') : null;
	const corePopupHtmlPath = coreRoot ? path.join(coreRoot, 'popup.html') : null;
	const coreSocialStreamPng = coreRoot ? path.join(coreRoot, 'sources', 'images', 'socialstream.png') : null;
	const coreVdoSdk = coreRoot ? path.join(coreRoot, 'thirdparty', 'vdoninja-sdk.js') : null;

	const checks = [];

	checks.push({
		id: 'popup_streamid_gate_exists',
		pass: lineContains(fallbackPopupPath, /if\s*\(\s*\(response\s*==\s*undefined\)\s*\|\|\s*\(!response\.streamID\)\s*\)\s*\{/),
		note: 'Popup ignores settings until streamID exists'
	});
	checks.push({
		id: 'popup_callback_timeout_500ms_exists',
		pass: lineContains(fallbackPopupPath, /setTimeout\(\(\)\s*=>\s*\{[\s\S]*?ipcRenderer\.sendSync\('fromPopup',\s*data\);[\s\S]*?\},\s*500\);/),
		note: 'Async callback falls back to sync after 500ms'
	});
	checks.push({
		id: 'main_frompopup_getsettings_sync_cachedstate',
		pass: lineContains(mainPath, /if\s*\(value\.cmd\s*==\s*"getSettings"\)\s*\{\s*eventRet\.returnValue\s*=\s*cachedState;/),
		note: 'Main returns cachedState immediately on getSettings'
	});
	checks.push({
		id: 'background_preload_tryagain_signature',
		pass: lineContains(fallbackBackgroundPath, /if\s*\(!loadedFirst\)\s*\{[\s\S]*?sendResponse\(\{"tryAgain":true\}\);/),
		note: 'Background can emit {tryAgain:true} before fully loaded'
	});
	checks.push({
		id: 'popup_and_background_resolved_independently',
		pass:
			lineContains(indexPath, /resolveSocialStreamPage\('popup\.html'/) &&
			lineContains(indexPath, /resolveSocialStreamPage\('background\.html'/),
		note: 'Popup/background load paths are separate and can diverge in origin/branch'
	});
	checks.push({
		id: 'fallback_popup_references_socialstream_png',
		pass: lineContains(fallbackPopupHtmlPath, /sources\/images\/socialstream\.png/i),
		note: 'Popup references Social Stream icon path'
	});
	checks.push({
		id: 'fallback_socialstream_png_exact_case_exists',
		pass: existsWithExactCase(fallbackSocialStreamPng),
		note: 'Exact-case icon path exists on disk'
	});
	checks.push({
		id: 'fallback_vdoninja_sdk_exists',
		pass: exists(fallbackVdoSdk),
		note: 'Fallback includes vdoninja-sdk.js'
	});

	if (coreRoot && corePopupPath && coreBackgroundPath && corePopupHtmlPath) {
		checks.push({
			id: 'core_popup_references_socialstream_png',
			pass: lineContains(corePopupHtmlPath, /sources\/images\/socialstream\.png/i),
			note: 'Core popup references Social Stream icon path'
		});
		checks.push({
			id: 'core_socialstream_png_exact_case_exists',
			pass: existsWithExactCase(coreSocialStreamPng),
			note: 'Exact-case icon path exists in core'
		});
		checks.push({
			id: 'core_vdoninja_loader_signature',
			pass: lineContains(coreBackgroundPath, /thirdparty\/vdoninja-sdk\.js/),
			note: 'Core background lazy-loads vdoninja-sdk.js'
		});
		checks.push({
			id: 'core_vdoninja_sdk_exists',
			pass: exists(coreVdoSdk),
			note: 'Core sdk file exists on disk'
		});
	}

	const dataDir = findDataDir();
	const disk = {
		dataDir,
		savedSyncExists: false,
		savedSyncSettingsKeys: 0,
		configExists: false,
		configBackupSettingsKeys: 0
	};
	if (dataDir) {
		const savedSyncPath = path.join(dataDir, 'savedSync.json');
		const configPath = path.join(dataDir, 'config.json');
		const savedSync = parseJson(savedSyncPath);
		const config = parseJson(configPath);
		disk.savedSyncExists = !!savedSync;
		disk.savedSyncSettingsKeys = settingsKeyCount(savedSync && savedSync.settings);
		disk.configExists = !!config;
		disk.configBackupSettingsKeys = settingsKeyCount(parseEmbeddedSettingsFromConfig(config));
	}

	console.log('settings-rootcause-diagnostics');
	console.log('');
	console.log('Code/Asset Checks:');
	for (const check of checks) {
		const status = check.pass ? 'PASS' : 'FAIL';
		console.log(`- ${status} ${check.id} :: ${check.note}`);
	}

	console.log('');
	console.log('Disk/Profile Checks:');
	if (!disk.dataDir) {
		console.log('- dataDir: not found');
	} else {
		console.log(`- dataDir: ${disk.dataDir}`);
		console.log(`- savedSync exists: ${disk.savedSyncExists}`);
		console.log(`- savedSync settings key count: ${disk.savedSyncSettingsKeys}`);
		console.log(`- config exists: ${disk.configExists}`);
		console.log(`- config localStorageBackup.settings key count: ${disk.configBackupSettingsKeys}`);
	}

	console.log('');
	console.log('Interpretation:');
	const hasRaceSignature = checks
		.filter((c) =>
			[
				'popup_streamid_gate_exists',
				'popup_callback_timeout_500ms_exists',
				'main_frompopup_getsettings_sync_cachedstate',
				'background_preload_tryagain_signature'
			].includes(c.id)
		)
		.every((c) => c.pass);
	const hasSplitSourceRisk = checks.find((c) => c.id === 'popup_and_background_resolved_independently')?.pass === true;
	const hasIconMismatch =
		checks.find((c) => c.id === 'fallback_popup_references_socialstream_png')?.pass === true &&
		checks.find((c) => c.id === 'fallback_socialstream_png_exact_case_exists')?.pass === false;
	const hasMinimalSavedSettings = disk.savedSyncSettingsKeys > 0 && disk.savedSyncSettingsKeys <= 10;

	console.log(`- race_signature_present: ${hasRaceSignature}`);
	console.log(`- split_source_risk_present: ${hasSplitSourceRisk}`);
	console.log(`- icon_path_mismatch_present: ${hasIconMismatch}`);
	console.log(`- minimal_saved_settings_profile: ${hasMinimalSavedSettings}`);
}

try {
	run();
	process.exit(0);
} catch (error) {
	console.error('settings-rootcause-diagnostics: failed');
	console.error(error && error.stack ? error.stack : error);
	process.exit(1);
}
