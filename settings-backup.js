'use strict';

const fs = require('fs');

const SETTINGS_BACKUP_FORMAT = 'ssapp-settings-backup';
const SETTINGS_BACKUP_VERSION = 1;

const LOCAL_STORAGE_SETTING_KEYS = [
	'socialStreamState',
	'settings',
	'betaMode',
	'youtubeAutoAdd',
	'youtubeAutoCleanup',
	'youtubeCheckInterval',
	'forceTikTokClassic',
	'preferTikTokLegacy',
	'tiktokModeExplicitlySelected',
	'lastTikTokMode',
	'language'
];

function isPlainObject(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function copyRecognizedCachedStateFields(state) {
	const source = isPlainObject(state) ? state : {};
	const payload = {};

	if (hasOwn(source, 'streamID')) {
		payload.streamID = source.streamID;
	}
	if (hasOwn(source, 'password')) {
		payload.password = source.password;
	}
	if (hasOwn(source, 'state')) {
		payload.state = source.state;
	}
	if (isPlainObject(source.settings)) {
		payload.settings = source.settings;
	}

	return payload;
}

function normalizeLocalStoragePayload(value) {
	if (!isPlainObject(value)) return {};
	const localStorage = {};
	for (const key of LOCAL_STORAGE_SETTING_KEYS) {
		if (!hasOwn(value, key)) continue;
		const item = value[key];
		if (item === null || item === undefined) continue;
		localStorage[key] = typeof item === 'string' ? item : String(item);
	}
	return localStorage;
}

function buildSettingsBackupPayload(cachedState, localStorageData = null) {
	const payload = copyRecognizedCachedStateFields(cachedState);
	const localStorage = normalizeLocalStoragePayload(localStorageData);

	payload.ssapp = {
		format: SETTINGS_BACKUP_FORMAT,
		version: SETTINGS_BACKUP_VERSION,
		exportedAt: new Date().toISOString(),
		includesLocalAppSettings: Object.keys(localStorage).length > 0
	};

	if (Object.keys(localStorage).length > 0) {
		payload.localStorage = localStorage;
	}

	return payload;
}

function normalizeSettingsBackupPayload(input) {
	if (!isPlainObject(input)) {
		throw new Error('Settings file must contain a JSON object');
	}

	const cachedState = copyRecognizedCachedStateFields(input);
	const localStorage = normalizeLocalStoragePayload(input.localStorage);

	if (!Object.keys(cachedState).length && !Object.keys(localStorage).length) {
		throw new Error('Settings file does not contain recognized Social Stream settings');
	}

	return {
		cachedState,
		localStorage,
		meta: isPlainObject(input.ssapp) ? input.ssapp : null
	};
}

function parseSettingsBackupText(text) {
	let parsed = null;
	try {
		parsed = JSON.parse(String(text || ''));
	} catch (error) {
		throw new Error(`Invalid settings JSON: ${error && error.message ? error.message : error}`);
	}
	return normalizeSettingsBackupPayload(parsed);
}

function readSettingsBackupFile(filePath) {
	return parseSettingsBackupText(fs.readFileSync(filePath, 'utf8'));
}

function writeSettingsBackupFile(filePath, cachedState, localStorageData = null) {
	const payload = buildSettingsBackupPayload(cachedState, localStorageData);
	fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
	return payload;
}

module.exports = {
	SETTINGS_BACKUP_FORMAT,
	SETTINGS_BACKUP_VERSION,
	LOCAL_STORAGE_SETTING_KEYS,
	buildSettingsBackupPayload,
	normalizeSettingsBackupPayload,
	parseSettingsBackupText,
	readSettingsBackupFile,
	writeSettingsBackupFile
};
