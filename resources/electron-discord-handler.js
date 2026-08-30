'use strict';

const crypto = require('crypto');
const path = require('path');
const { ipcMain, safeStorage, shell } = require('electron');
const Store = require('electron-store');
const {
	DiscordBotClient,
	PERMISSION_SEND_MESSAGES,
	PERMISSION_VIEW_CHANNEL,
} = require('./discord-bot-client');

const AUTH_STORE_KEY = 'discordBotAuth';
const AUTH_STORE_VERSION = 1;
const FIRST_VIRTUAL_TAB_ID = 1_000_000;
const ALLOWED_EXTERNAL_HOSTS = new Set(['discord.com', 'www.discord.com']);
const discordAuthStore = new Store({ name: 'discord-bot-auth' });

let activeIntegration = null;
let ipcRegistered = false;

function getSenderFrameUrl(event) {
	try {
		if (event?.senderFrame?.url) return String(event.senderFrame.url);
	} catch (_) {}
	try {
		if (event?.sender && typeof event.sender.getURL === 'function') {
			return String(event.sender.getURL() || '');
		}
	} catch (_) {}
	return '';
}

function isMainAppFrameUrl(frameUrl) {
	if (!frameUrl || typeof frameUrl !== 'string') return false;
	try {
		const parsed = new URL(frameUrl);
		if (parsed.protocol !== 'file:') return false;
		const senderPath = path.normalize(decodeURIComponent(parsed.pathname || '').replace(/^\/([A-Za-z]:)/, '$1'));
		const indexPath = path.normalize(path.join(__dirname, '..', 'index.html'));
		return senderPath.toLowerCase() === indexPath.toLowerCase();
	} catch (_) {
		return false;
	}
}

function assertMainAppCaller(event) {
	const frameUrl = getSenderFrameUrl(event);
	if (isMainAppFrameUrl(frameUrl)) return;
	const error = new Error('Discord bot controls are only available to the main app UI.');
	error.code = 'SSAPP_DISCORD_FORBIDDEN';
	console.warn('[Discord] Blocked bot-control IPC from a non-app frame:', frameUrl || 'unknown');
	throw error;
}

function normalizeError(error) {
	return {
		code: error?.code || 'SSAPP_DISCORD_ERROR',
		message: error?.message || String(error || 'Discord operation failed.'),
	};
}

function success(value = {}) {
	return { success: true, ...value };
}

function failure(error) {
	return { success: false, error: normalizeError(error) };
}

function readAuthEntries() {
	const stored = discordAuthStore.get(AUTH_STORE_KEY, null);
	if (!stored || stored.version !== AUTH_STORE_VERSION || !stored.entries || typeof stored.entries !== 'object') {
		return {};
	}
	return stored.entries;
}

function writeAuthEntries(entries) {
	discordAuthStore.set(AUTH_STORE_KEY, {
		version: AUTH_STORE_VERSION,
		entries,
	});
}

function protectToken(token) {
	if (!safeStorage.isEncryptionAvailable()) {
		const error = new Error('Secure credential storage is unavailable on this computer. Discord bot tokens will not be saved in plain text.');
		error.code = 'SSAPP_DISCORD_SECURE_STORAGE_UNAVAILABLE';
		throw error;
	}
	return safeStorage.encryptString(String(token || '')).toString('base64');
}

function revealToken(entry) {
	if (!entry?.protectedToken) {
		const error = new Error('The saved Discord bot token is missing.');
		error.code = 'SSAPP_DISCORD_AUTH_MISSING';
		throw error;
	}
	if (!safeStorage.isEncryptionAvailable()) {
		const error = new Error('Secure credential storage is unavailable, so the saved Discord bot token cannot be opened.');
		error.code = 'SSAPP_DISCORD_SECURE_STORAGE_UNAVAILABLE';
		throw error;
	}
	try {
		return safeStorage.decryptString(Buffer.from(entry.protectedToken, 'base64'));
	} catch (_) {
		const error = new Error('The saved Discord bot token could not be decrypted. Replace the token and try again.');
		error.code = 'SSAPP_DISCORD_AUTH_DECRYPT_FAILED';
		throw error;
	}
}

function publicCredential(authRef, entry) {
	return {
		authRef,
		applicationId: entry.applicationId || '',
		botUserId: entry.botUserId || '',
		username: entry.username || 'Discord bot',
		avatar: entry.avatar || '',
		addedAt: Number(entry.addedAt || 0),
		updatedAt: Number(entry.updatedAt || 0),
	};
}

function buildBotAvatarUrl(user) {
	if (!user?.id || !user?.avatar) return '';
	const extension = String(user.avatar).startsWith('a_') ? 'gif' : 'png';
	return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=128`;
}

function buildInstallUrl(applicationId) {
	const clientId = String(applicationId || '').trim();
	if (!clientId) return '';
	const permissions = (PERMISSION_VIEW_CHANNEL | PERMISSION_SEND_MESSAGES).toString();
	return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot&permissions=${permissions}&integration_type=0`;
}

function buildDeveloperPortalUrl(applicationId) {
	const clientId = String(applicationId || '').trim();
	return clientId
		? `https://discord.com/developers/applications/${encodeURIComponent(clientId)}/bot`
		: 'https://discord.com/developers/applications';
}

function validateExternalUrl(value) {
	const parsed = new URL(String(value || ''));
	if (parsed.protocol !== 'https:' || !ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase())) {
		const error = new Error('Only Discord setup and channel links can be opened here.');
		error.code = 'SSAPP_DISCORD_EXTERNAL_URL_BLOCKED';
		throw error;
	}
	const allowedPath = parsed.pathname.startsWith('/developers/')
		|| parsed.pathname.startsWith('/oauth2/')
		|| parsed.pathname.startsWith('/channels/');
	if (!allowedPath) {
		const error = new Error('This Discord link is outside the supported setup flow.');
		error.code = 'SSAPP_DISCORD_EXTERNAL_URL_BLOCKED';
		throw error;
	}
	return parsed.toString();
}

class DiscordIntegration {
	constructor(options = {}) {
		this.getMainWindow = typeof options.getMainWindow === 'function' ? options.getMainWindow : () => null;
		this.getBrowserViews = typeof options.getBrowserViews === 'function' ? options.getBrowserViews : () => ({});
		this.getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({});
		this.forwardMessage = typeof options.forwardMessage === 'function' ? options.forwardMessage : () => false;
		this.recordCapture = typeof options.recordCapture === 'function' ? options.recordCapture : () => {};
		this.recordStatus = typeof options.recordStatus === 'function' ? options.recordStatus : () => {};
		this.clientOptions = options.clientOptions && typeof options.clientOptions === 'object' ? options.clientOptions : {};
		this.clientFactory = options.clientFactory || ((token) => new DiscordBotClient(token, {
			...this.clientOptions,
			getSettings: this.getSettings,
		}));
		this.clients = new Map();
		this.sourceBindings = new Map();
		this.nextVirtualTabId = FIRST_VIRTUAL_TAB_ID;
	}

	listBots() {
		const entries = readAuthEntries();
		return Object.entries(entries)
			.map(([authRef, entry]) => publicCredential(authRef, entry))
			.sort((left, right) => left.username.localeCompare(right.username));
	}

	async saveBot(payload = {}) {
		const token = String(payload.token || '').trim();
		if (!token) {
			const error = new Error('Paste a Discord bot token first.');
			error.code = 'SSAPP_DISCORD_TOKEN_REQUIRED';
			throw error;
		}

		const validationClient = this.clientFactory(token);
		const { botUser, application } = await validationClient.validate();
		validationClient.close();
		const protectedToken = protectToken(token);

		const entries = readAuthEntries();
		const requestedRef = String(payload.authRef || '').trim();
		const authRef = requestedRef && entries[requestedRef] ? requestedRef : crypto.randomUUID();
		const affectedSourceIds = Array.from(this.sourceBindings.entries())
			.filter(([, binding]) => binding.authRef === authRef)
			.map(([sourceId]) => sourceId);
		for (const sourceId of affectedSourceIds) this.disconnectSource(sourceId);
		const now = Date.now();
		entries[authRef] = {
			protectedToken,
			applicationId: String(application?.id || ''),
			botUserId: String(botUser?.id || ''),
			username: botUser?.global_name || botUser?.username || 'Discord bot',
			avatar: buildBotAvatarUrl(botUser),
			addedAt: entries[authRef]?.addedAt || now,
			updatedAt: now,
		};
		writeAuthEntries(entries);

		this._retireClient(authRef);
		return {
			bot: publicCredential(authRef, entries[authRef]),
			affectedSourceIds,
		};
	}

	async removeBot(authRef) {
		const key = String(authRef || '').trim();
		if (!key) return [];
		const affectedSourceIds = Array.from(this.sourceBindings.entries())
			.filter(([, binding]) => binding.authRef === key)
			.map(([sourceId]) => sourceId);
		for (const sourceId of affectedSourceIds) this.disconnectSource(sourceId);
		this._retireClient(key);
		const entries = readAuthEntries();
		delete entries[key];
		writeAuthEntries(entries);
		return affectedSourceIds;
	}

	async discover(authRef) {
		const key = String(authRef || '').trim();
		const client = this._getClient(key);
		const guilds = await client.discoverGuilds();
		const credential = this._credential(key);
		return {
			bot: publicCredential(key, credential),
			guilds,
			installUrl: buildInstallUrl(credential.applicationId),
			developerPortalUrl: buildDeveloperPortalUrl(credential.applicationId),
		};
	}

	async connectSource(payload = {}) {
		const sourceId = String(payload.sourceId || '').trim();
		const authRef = String(payload.authRef || payload.discordAuthRef || '').trim();
		const guildId = String(payload.guildId || '').trim();
		const channelId = String(payload.channelId || '').trim();
		if (!sourceId || !authRef || !guildId || !channelId) {
			const error = new Error('Discord source setup is missing its bot, server, or channel selection.');
			error.code = 'SSAPP_DISCORD_SOURCE_INVALID';
			throw error;
		}

		if (this.sourceBindings.has(sourceId)) this.disconnectSource(sourceId);
		const client = this._getClient(authRef);
		await client.validateSourceChannel(guildId, channelId);
		const virtualTabId = this._allocateVirtualTabId();
		const url = `https://discord.com/channels/${encodeURIComponent(guildId)}/${encodeURIComponent(channelId)}`;
		const source = {
			sourceId,
			authRef,
			guildId,
			channelId,
			virtualTabId,
			includeWebhookMessages: payload.includeWebhookMessages === true,
			replyOnly: payload.replyOnly === true,
			accountRole: payload.accountRole,
			customSession: payload.customSession,
		};

		client.addSource(source);
		const view = this._makeVirtualView(source, client, url);
		this.getBrowserViews()[virtualTabId] = view;
		this.sourceBindings.set(sourceId, { authRef, virtualTabId, client });

		try {
			await client.connect();
			client.emitSourceStatus(
				sourceId,
				'connected',
				`Connected as ${client.botUser?.global_name || client.botUser?.username || 'Discord bot'}.`
			);
		} catch (error) {
			this.disconnectSource(sourceId);
			throw error;
		}

		return {
			virtualTabId,
			url,
			bot: publicCredential(authRef, this._credential(authRef)),
		};
	}

	disconnectSource(sourceId) {
		const key = String(sourceId || '').trim();
		const binding = this.sourceBindings.get(key);
		if (!binding) return false;
		this.sourceBindings.delete(key);
		binding.client.removeSource(key);
		const views = this.getBrowserViews();
		if (views[binding.virtualTabId]) delete views[binding.virtualTabId];
		return true;
	}

	async openExternal(value) {
		const url = validateExternalUrl(value);
		await shell.openExternal(url);
		return true;
	}

	closeAll() {
		for (const client of this.clients.values()) client.close();
		for (const binding of this.sourceBindings.values()) {
			const views = this.getBrowserViews();
			if (views[binding.virtualTabId]) delete views[binding.virtualTabId];
		}
		this.sourceBindings.clear();
		this.clients.clear();
	}

	_credential(authRef) {
		const entries = readAuthEntries();
		const entry = entries[authRef];
		if (!entry) {
			const error = new Error('That saved Discord bot was not found. Add or replace the bot token.');
			error.code = 'SSAPP_DISCORD_AUTH_MISSING';
			throw error;
		}
		return entry;
	}

	_getClient(authRef) {
		if (this.clients.has(authRef)) return this.clients.get(authRef);
		const entry = this._credential(authRef);
		const client = this.clientFactory(revealToken(entry));
		client.on('message', ({ payload, source }) => {
			this.recordCapture({ message: payload }, { sourceId: source.sourceId, tabId: source.virtualTabId });
			this.forwardMessage({ message: payload }, { sourceId: source.sourceId, tabId: source.virtualTabId });
		});
		client.on('status', (status) => {
			this.recordStatus(status, { sourceId: status.sourceId, tabId: status.virtualTabId });
			const mainWindow = this.getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
				mainWindow.webContents.send('discordConnectionStatus', status);
			}
		});
		client.on('warning', (warning) => {
			console.warn('[Discord]', warning?.message || 'Discord connection warning.');
		});
		this.clients.set(authRef, client);
		return client;
	}

	_retireClient(authRef) {
		const client = this.clients.get(authRef);
		if (client) client.close();
		this.clients.delete(authRef);
	}

	_allocateVirtualTabId() {
		const views = this.getBrowserViews();
		while (views[this.nextVirtualTabId]) this.nextVirtualTabId += 1;
		return this.nextVirtualTabId++;
	}

	_makeVirtualView(source, client, url) {
		const integration = this;
		return {
			isVirtualSource: true,
			virtualSourceTarget: 'discord',
			discordAuthRef: source.authRef,
			sourceId: source.sourceId,
			tabID: source.virtualTabId,
			args: {
				url,
				sourceId: source.sourceId,
				accountRole: source.accountRole,
				customSession: source.customSession,
			},
			webContents: {
				getURL: () => url,
				isDestroyed: () => false,
				send(channel, data) {
					if (channel !== 'sendToTab') return;
					client.sendToSource(source.sourceId, data).catch((error) => {
						const status = {
							sourceId: source.sourceId,
							virtualTabId: source.virtualTabId,
							status: 'error',
							message: error?.message || 'Could not send the Discord message.',
							code: error?.code || 'SSAPP_DISCORD_SEND_FAILED',
						};
						integration.recordStatus(status, { sourceId: source.sourceId, tabId: source.virtualTabId });
						const mainWindow = integration.getMainWindow();
						if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
							mainWindow.webContents.send('discordConnectionStatus', status);
						}
					});
				},
			},
			close: () => integration.disconnectSource(source.sourceId),
		};
	}
}

function registerIpc(integration) {
	if (ipcRegistered) return;
	ipcRegistered = true;

	ipcMain.handle('discord-bots-list', async (event) => {
		try {
			assertMainAppCaller(event);
			return success({ bots: integration.listBots() });
		} catch (error) {
			return failure(error);
		}
	});
	ipcMain.handle('discord-bot-save', async (event, payload) => {
		try {
			assertMainAppCaller(event);
			return success(await integration.saveBot(payload));
		} catch (error) {
			return failure(error);
		}
	});
	ipcMain.handle('discord-bot-remove', async (event, authRef) => {
		try {
			assertMainAppCaller(event);
			return success({ affectedSourceIds: await integration.removeBot(authRef) });
		} catch (error) {
			return failure(error);
		}
	});
	ipcMain.handle('discord-bot-discover', async (event, authRef) => {
		try {
			assertMainAppCaller(event);
			return success(await integration.discover(authRef));
		} catch (error) {
			return failure(error);
		}
	});
	ipcMain.handle('discord-source-connect', async (event, payload) => {
		try {
			assertMainAppCaller(event);
			return success(await integration.connectSource(payload));
		} catch (error) {
			return failure(error);
		}
	});
	ipcMain.handle('discord-source-disconnect', async (event, sourceId) => {
		try {
			assertMainAppCaller(event);
			return success({ disconnected: integration.disconnectSource(sourceId) });
		} catch (error) {
			return failure(error);
		}
	});
	ipcMain.handle('discord-open-external', async (event, url) => {
		try {
			assertMainAppCaller(event);
			return success({ opened: await integration.openExternal(url) });
		} catch (error) {
			return failure(error);
		}
	});
}

function setupDiscordHandler(options = {}) {
	if (activeIntegration) return activeIntegration;
	activeIntegration = new DiscordIntegration(options);
	registerIpc(activeIntegration);
	return activeIntegration;
}

function clearDiscordBotAuthStore() {
	if (activeIntegration) activeIntegration.closeAll();
	discordAuthStore.delete(AUTH_STORE_KEY);
}

module.exports = {
	DiscordIntegration,
	buildDeveloperPortalUrl,
	buildInstallUrl,
	clearDiscordBotAuthStore,
	setupDiscordHandler,
	validateExternalUrl,
};
