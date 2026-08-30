'use strict';

(function () {
	const modalState = {
		bots: [],
		discovery: null,
		editingSourceId: null,
		loading: false,
	};

	function bridge() {
		return window.ninjafy && window.ninjafy.discord ? window.ninjafy.discord : null;
	}

	function element(id) {
		return document.getElementById(id);
	}

	function resultValue(result) {
		if (result?.success) return result;
		const error = new Error(result?.error?.message || 'Discord setup failed.');
		error.code = result?.error?.code || 'SSAPP_DISCORD_ERROR';
		throw error;
	}

	function setStatus(message = '', type = '') {
		const status = element('discordSetupStatus');
		if (!status) return;
		status.textContent = message;
		status.className = `discord-setup-status${type ? ` ${type}` : ''}`;
	}

	function setLoading(loading, message = '') {
		modalState.loading = !!loading;
		const hasBot = !!element('discordBotSelect')?.value;
		const hasGuilds = !!modalState.discovery?.guilds?.length;
		const hasChannels = !!element('discordGuildSelect')?.value
			&& !!modalState.discovery?.guilds?.find((guild) => guild.id === element('discordGuildSelect').value)?.channels?.length;
		element('discordSaveBotButton').disabled = !!loading;
		element('discordRemoveBotButton').disabled = !!loading || !hasBot;
		element('discordRefreshChannelsButton').disabled = !!loading || !hasBot;
		element('discordInstallBotButton').disabled = !!loading || !hasBot || !modalState.discovery?.installUrl;
		element('discordAddSourceButton').disabled = !!loading || !canAddSource();
		element('discordBotSelect').disabled = !!loading;
		element('discordBotTokenInput').disabled = !!loading;
		element('discordGuildSelect').disabled = !!loading || !hasGuilds;
		element('discordChannelSelect').disabled = !!loading || !hasChannels;
		if (loading && message) setStatus(message, 'loading');
	}

	function canAddSource() {
		return !!(
			element('discordBotSelect')?.value
			&& element('discordGuildSelect')?.value
			&& element('discordChannelSelect')?.value
			&& !modalState.loading
		);
	}

	function refreshAddButton() {
		const button = element('discordAddSourceButton');
		if (button) button.disabled = !canAddSource();
	}

	function selectedBot() {
		const authRef = element('discordBotSelect')?.value || '';
		return modalState.bots.find((bot) => bot.authRef === authRef) || null;
	}

	function editingSource() {
		return modalState.editingSourceId && window.stateManager
			? stateManager.getSource(modalState.editingSourceId)
			: null;
	}

	function markSourcesDisconnected(sourceIds, message = null) {
		if (!window.stateManager) return;
		for (const sourceId of Array.isArray(sourceIds) ? sourceIds : []) {
			const source = stateManager.getSource(sourceId);
			if (!source) continue;
			stateManager.updateSource(sourceId, {
				status: message ? 'error' : 'inactive',
				error: message,
				vid: null,
				wssId: null,
				activeConnectionMode: null,
			});
		}
	}

	function resetChannelSelectors(message = 'Select a saved bot first') {
		const guildSelect = element('discordGuildSelect');
		const channelSelect = element('discordChannelSelect');
		if (guildSelect) {
			guildSelect.replaceChildren(new Option(message, ''));
			guildSelect.disabled = true;
		}
		if (channelSelect) {
			channelSelect.replaceChildren(new Option('Select a server first', ''));
			channelSelect.disabled = true;
		}
		refreshAddButton();
	}

	function renderBotSelect(preferredAuthRef = '') {
		const select = element('discordBotSelect');
		if (!select) return;
		select.replaceChildren();
		select.appendChild(new Option(modalState.bots.length ? 'Add another bot...' : 'Add your first bot...', ''));
		for (const bot of modalState.bots) {
			select.appendChild(new Option(bot.username || 'Discord bot', bot.authRef));
		}
		const preferred = preferredAuthRef || editingSource()?.discordAuthRef || '';
		if (preferred && modalState.bots.some((bot) => bot.authRef === preferred)) select.value = preferred;
		const hasSelection = !!select.value;
		element('discordRemoveBotButton')?.classList.toggle('hidden', !hasSelection);
		element('discordRefreshChannelsButton').disabled = !hasSelection;
		element('discordInstallBotButton').disabled = !hasSelection;
	}

	function populateGuilds(preferredGuildId = '', preferredChannelId = '') {
		const guildSelect = element('discordGuildSelect');
		if (!guildSelect) return;
		const guilds = Array.isArray(modalState.discovery?.guilds) ? modalState.discovery.guilds : [];
		guildSelect.replaceChildren(new Option(guilds.length ? 'Select a server...' : 'No installed servers found', ''));
		for (const guild of guilds) guildSelect.appendChild(new Option(guild.name || 'Discord server', guild.id));
		guildSelect.disabled = !guilds.length;
		const preferred = preferredGuildId || editingSource()?.guildId || '';
		if (preferred && guilds.some((guild) => guild.id === preferred)) guildSelect.value = preferred;
		populateChannels(preferredChannelId || editingSource()?.channelId || '');
	}

	function populateChannels(preferredChannelId = '') {
		const guildId = element('discordGuildSelect')?.value || '';
		const channelSelect = element('discordChannelSelect');
		if (!channelSelect) return;
		const guild = (modalState.discovery?.guilds || []).find((item) => item.id === guildId);
		const channels = Array.isArray(guild?.channels) ? guild.channels : [];
		channelSelect.replaceChildren(new Option(guildId ? (channels.length ? 'Select a channel...' : 'No visible text channels') : 'Select a server first', ''));
		for (const channel of channels) {
			const sendNote = channel.canSend ? '' : ' (capture only)';
			const category = channel.categoryName ? `${channel.categoryName} / ` : '';
			channelSelect.appendChild(new Option(`${category}#${channel.name}${sendNote}`, channel.id));
		}
		channelSelect.disabled = !channels.length;
		if (preferredChannelId && channels.some((channel) => channel.id === preferredChannelId)) {
			channelSelect.value = preferredChannelId;
		}
		refreshAddButton();
	}

	async function loadBots(preferredAuthRef = '') {
		const discord = bridge();
		if (!discord) throw new Error('The native Discord bridge is unavailable. Restart SSApp and try again.');
		const result = resultValue(await discord.listBots());
		modalState.bots = Array.isArray(result.bots) ? result.bots : [];
		renderBotSelect(preferredAuthRef);
		if (element('discordBotSelect')?.value) await discoverSelectedBot();
		else resetChannelSelectors();
	}

	async function discoverSelectedBot() {
		const discord = bridge();
		const authRef = element('discordBotSelect')?.value || '';
		modalState.discovery = null;
		element('discordRemoveBotButton')?.classList.toggle('hidden', !authRef);
		element('discordRefreshChannelsButton').disabled = !authRef;
		element('discordInstallBotButton').disabled = !authRef;
		if (!authRef) {
			resetChannelSelectors();
			setStatus('Paste a bot token to continue.');
			return;
		}
		try {
			setLoading(true, 'Checking the bot and loading its servers...');
			const result = resultValue(await discord.discover(authRef));
			modalState.discovery = result;
			const current = editingSource();
			populateGuilds(current?.discordAuthRef === authRef ? current.guildId : '', current?.discordAuthRef === authRef ? current.channelId : '');
			setStatus(result.guilds?.length
				? `Connected as ${result.bot?.username || 'Discord bot'}. Choose a server and channel.`
				: 'The bot is valid but is not installed in a server yet. Use “Install bot in a server”, then refresh.', result.guilds?.length ? 'success' : 'info');
		} catch (error) {
			resetChannelSelectors('Could not load servers');
			setStatus(error.message, 'error');
		} finally {
			setLoading(false);
		}
	}

	async function saveBot() {
		const discord = bridge();
		const tokenInput = element('discordBotTokenInput');
		const token = tokenInput?.value?.trim() || '';
		if (!token) {
			setStatus('Paste a Discord bot token first.', 'error');
			tokenInput?.focus();
			return;
		}
		try {
			setLoading(true, 'Verifying and encrypting the bot token...');
			const result = resultValue(await discord.saveBot({
				token,
				authRef: element('discordBotSelect')?.value || '',
			}));
			if (tokenInput) tokenInput.value = '';
			markSourcesDisconnected(result.affectedSourceIds);
			await loadBots(result.bot.authRef);
			setStatus(`Saved ${result.bot.username}. The token is encrypted on this computer.`, 'success');
		} catch (error) {
			setStatus(error.message, 'error');
		} finally {
			setLoading(false);
		}
	}

	async function removeBot() {
		const bot = selectedBot();
		if (!bot) return;
		if (!window.confirm(`Forget the saved token for ${bot.username}? Sources using it will stop until another token is selected.`)) return;
		try {
			setLoading(true, 'Removing the saved bot token...');
			const result = resultValue(await bridge().removeBot(bot.authRef));
			markSourcesDisconnected(result.affectedSourceIds, 'Saved Discord bot token was removed.');
			modalState.discovery = null;
			await loadBots();
			setStatus('The saved bot token was removed.', 'success');
		} catch (error) {
			setStatus(error.message, 'error');
		} finally {
			setLoading(false);
		}
	}

	async function openDiscordUrl(url) {
		try {
			resultValue(await bridge().openExternal(url));
		} catch (error) {
			setStatus(error.message, 'error');
		}
	}

	async function addOrUpdateSource() {
		const authRef = element('discordBotSelect')?.value || '';
		const guildId = element('discordGuildSelect')?.value || '';
		const channelId = element('discordChannelSelect')?.value || '';
		const guild = (modalState.discovery?.guilds || []).find((item) => item.id === guildId);
		const channel = guild?.channels?.find((item) => item.id === channelId);
		if (!authRef || !guild || !channel) {
			setStatus('Choose a saved bot, server, and channel.', 'error');
			return;
		}

		const sourceData = {
			target: 'discord',
			username: `${guild.name} · #${channel.name}`,
			url: `https://discord.com/channels/${guild.id}/${channel.id}`,
			guildId: guild.id,
			channelId: channel.id,
			discordAuthRef: authRef,
			discordNative: true,
			includeWebhookMessages: !!element('discordIncludeWebhooksInput')?.checked,
			connectionMode: 'websocket',
			supportsWSS: true,
			isVisible: false,
			isMuted: true,
			autoActivate: false,
			sourceFile: 'sources/discord.js',
		};

		const existing = editingSource();
		if (existing) {
			const wasActive = !!(existing.vid || existing.wssId || existing.status === 'active' || existing.status === 'activating');
			try {
				if (wasActive) resultValue(await bridge().disconnectSource(existing.id));
			} catch (error) {
				setStatus(error.message, 'error');
				return;
			}
			stateManager.updateSource(existing.id, {
				...sourceData,
				status: 'inactive',
				error: null,
				vid: null,
				wssId: null,
				activeConnectionMode: null,
			});
			closeModal();
			Toast.success('Discord source updated', `${sourceData.username} is ready.`);
			if (wasActive) {
				const entry = document.querySelector(`[data-source-id="${existing.id}"]`);
				const button = entry?.querySelector('[data-activatehtml]');
				if (button) await activateSource(button);
			}
			return;
		}

		const duplicate = stateManager.getSources().find((source) =>
			source?.discordNative
			&& source.discordAuthRef === authRef
			&& source.guildId === guild.id
			&& source.channelId === channel.id
		);
		if (duplicate) {
			setStatus('That bot and channel are already in your source list.', 'info');
			return;
		}

		const sourceId = stateManager.addSource({
			...sourceData,
			id: `discord-${guild.id}-${channel.id}-${authRef}`,
		});
		closeModal();
		if (typeof manageWelcomePage === 'function') manageWelcomePage();
		Toast.success('Discord source added', `${sourceData.username} is ready. Activate it to connect.`);
		return sourceId;
	}

	function showNativeSetup() {
		element('discordModeChoice')?.classList.add('hidden');
		element('discordNativeSetup')?.classList.remove('hidden');
		element('discordBackButton')?.classList.remove('hidden');
		element('discordAddSourceButton')?.classList.remove('hidden');
		loadBots(editingSource()?.discordAuthRef || '').catch((error) => setStatus(error.message, 'error'));
	}

	function showModeChoice() {
		element('discordModeChoice')?.classList.remove('hidden');
		element('discordNativeSetup')?.classList.add('hidden');
		element('discordBackButton')?.classList.add('hidden');
		element('discordAddSourceButton')?.classList.add('hidden');
		setStatus('');
	}

	function closeModal() {
		element('discordAddSourceModal')?.classList.add('hidden');
		modalState.editingSourceId = null;
		modalState.discovery = null;
	}

	async function showDiscordAddSourcePrompt(sourceId = null) {
		const modal = element('discordAddSourceModal');
		if (!modal) return;
		if (!bridge()) {
			Toast.error('Discord', 'The native Discord bridge is unavailable. Restart SSApp and try again.');
			return;
		}
		modalState.editingSourceId = sourceId || null;
		element('discordBotTokenInput').value = '';
		element('discordIncludeWebhooksInput').checked = !!editingSource()?.includeWebhookMessages;
		element('discordAddSourceButton').textContent = sourceId ? 'Save changes' : 'Add source';
		element('discordAddSourceTitle').textContent = sourceId ? 'Manage Discord source' : 'Add a Discord source';
		modal.classList.remove('hidden');
		if (sourceId) showNativeSetup();
		else showModeChoice();
	}

	async function toggleWebhookMessages(sourceId) {
		const source = stateManager.getSource(sourceId);
		if (!source) return;
		const includeWebhookMessages = !source.includeWebhookMessages;
		const wasActive = !!source.vid;
		try {
			if (wasActive) resultValue(await bridge().disconnectSource(sourceId));
		} catch (error) {
			Toast.error('Discord source', error.message);
			return;
		}
		stateManager.updateSource(sourceId, {
			includeWebhookMessages,
			...(wasActive ? { status: 'inactive', vid: null, wssId: null, activeConnectionMode: null } : {}),
		});
		Toast.info('Discord source', includeWebhookMessages ? 'Bot and webhook messages will be included.' : 'Bot and webhook messages will be ignored.');
		if (wasActive) {
			const entry = document.querySelector(`[data-source-id="${sourceId}"]`);
			const button = entry?.querySelector('[data-activatehtml]');
			if (button) await activateSource(button);
		}
	}

	function setupDiscordSourceControls(sourceElement, source) {
		if (!sourceElement || !source?.discordNative) return;
		sourceElement.classList.add('discord-native-source');
		const settingsMenu = sourceElement.querySelector('.settings-menu');
		if (!settingsMenu) return;

		settingsMenu.querySelector('.connection-modes')?.classList.add('hidden');
		sourceElement.querySelector('.mode-selector')?.classList.add('hidden');
		for (const selector of [
			'[data-clearcache]',
			'[data-signin-chrome]',
			'.settings-menu-item[onclick^="openUserAgentSettings"]',
			'.settings-menu-item[onclick^="openSessionSettings"]',
		]) {
			settingsMenu.querySelector(selector)?.classList.add('hidden');
		}

		let section = settingsMenu.querySelector('[data-discord-native-settings]');
		if (!section) {
			section = document.createElement('div');
			section.className = 'settings-menu-section';
			section.dataset.discordNativeSettings = 'true';
			const heading = document.createElement('div');
			heading.className = 'settings-menu-header';
			heading.textContent = 'Discord bot';
			section.appendChild(heading);

			const manage = document.createElement('div');
			manage.className = 'settings-menu-item';
			manage.textContent = 'Manage bot or change channel';
			manage.addEventListener('click', () => showDiscordAddSourcePrompt(source.id));
			section.appendChild(manage);

			const webhooks = document.createElement('div');
			webhooks.className = 'settings-menu-item';
			webhooks.dataset.discordWebhooks = 'true';
			webhooks.addEventListener('click', () => toggleWebhookMessages(source.id));
			section.appendChild(webhooks);

			const openChannel = document.createElement('div');
			openChannel.className = 'settings-menu-item';
			openChannel.textContent = 'Open channel in Discord';
			openChannel.addEventListener('click', () => openDiscordUrl(stateManager.getSource(source.id)?.url || source.url));
			section.appendChild(openChannel);

			const management = settingsMenu.querySelector('.settings-menu-section:last-child');
			settingsMenu.insertBefore(section, management || null);
		}

		const webhooks = section.querySelector('[data-discord-webhooks]');
		if (webhooks) {
			webhooks.classList.toggle('active', !!source.includeWebhookMessages);
			webhooks.textContent = source.includeWebhookMessages
				? 'Include bot/webhook messages: On'
				: 'Include bot/webhook messages: Off';
		}
	}

	function applyDiscordNativeSourceUI(sourceElement, source) {
		if (!sourceElement || !source?.discordNative) return;
		const nativeBadge = sourceElement.querySelector('[data-session-badge]');
		if (nativeBadge) {
			nativeBadge.classList.remove('hidden');
			nativeBadge.textContent = 'Native bot';
			nativeBadge.title = 'Connects directly from SSApp; Discord Web does not need to be open.';
		}
		sourceElement.querySelector('[data-signin]')?.classList.add('hidden');
		sourceElement.querySelector('[data-reloadhtml]')?.classList.add('hidden');
		sourceElement.querySelector('[data-togglehtml]')?.classList.add('hidden');
		sourceElement.querySelector('[data-togglemute]')?.classList.add('hidden');
		sourceElement.querySelector('.mode-selector')?.classList.add('hidden');
		sourceElement.querySelector('.connection-modes')?.classList.add('hidden');
		const help = sourceElement.querySelector('[data-showtips]');
		if (help) {
			help.classList.remove('hidden');
			help.textContent = '? Setup';
			help.title = 'Review the Discord bot, permissions, and selected channel';
			help.onclick = () => showDiscordAddSourcePrompt(source.id);
		}
		const activate = sourceElement.querySelector('[data-activatehtml]');
		if (activate && source.status !== 'active' && !source.vid) activate.textContent = 'Connect Discord bot';
		setupDiscordSourceControls(sourceElement, source);
	}

	function handleConnectionStatus(status) {
		const sourceId = status?.sourceId;
		if (!sourceId || !window.stateManager) return;
		const source = stateManager.getSource(sourceId);
		if (!source?.discordNative) return;
		const entry = document.querySelector(`[data-source-id="${sourceId}"]`);
		if (status.status === 'connected') {
			stateManager.updateSource(sourceId, {
				status: 'active',
				error: null,
				vid: status.virtualTabId || source.vid,
				wssId: status.virtualTabId || source.wssId,
				activeConnectionMode: 'websocket',
			});
			if (entry && typeof updateConnectionStatus === 'function') updateConnectionStatus(entry, 'connected', status.message);
			return;
		}
		if (status.status === 'connecting' || status.status === 'reconnecting') {
			stateManager.updateSource(sourceId, {
				status: 'activating',
				error: null,
				vid: status.virtualTabId || source.vid,
				wssId: status.virtualTabId || source.wssId,
				activeConnectionMode: 'websocket',
			});
			if (entry && typeof updateConnectionStatus === 'function') updateConnectionStatus(entry, 'connecting', status.message);
			return;
		}
		if (status.status === 'error') {
			if (status.fatal) {
				stateManager.updateSource(sourceId, { status: 'error', error: status.message || 'Discord connection failed.' });
			}
			if (entry && typeof updateConnectionStatus === 'function') updateConnectionStatus(entry, 'error', status.message);
			if (!status.fatal) Toast.error('Discord', status.message || 'Could not send the Discord message.');
		}
	}

	function initializeModal() {
		const modal = element('discordAddSourceModal');
		if (!modal || modal.dataset.initialized === 'true') return;
		modal.dataset.initialized = 'true';
		element('discordNativeModeButton')?.addEventListener('click', showNativeSetup);
		element('discordWebModeButton')?.addEventListener('click', () => {
			closeModal();
			if (typeof newOtherSourcePrompt === 'function') newOtherSourcePrompt('discord');
		});
		element('discordBackButton')?.addEventListener('click', showModeChoice);
		element('discordCancelButton')?.addEventListener('click', closeModal);
		element('discordSaveBotButton')?.addEventListener('click', saveBot);
		element('discordRemoveBotButton')?.addEventListener('click', removeBot);
		element('discordBotSelect')?.addEventListener('change', discoverSelectedBot);
		element('discordGuildSelect')?.addEventListener('change', () => populateChannels());
		element('discordChannelSelect')?.addEventListener('change', refreshAddButton);
		element('discordRefreshChannelsButton')?.addEventListener('click', discoverSelectedBot);
		element('discordOpenDeveloperPortalButton')?.addEventListener('click', () => openDiscordUrl(modalState.discovery?.developerPortalUrl || 'https://discord.com/developers/applications'));
		element('discordInstallBotButton')?.addEventListener('click', () => openDiscordUrl(modalState.discovery?.installUrl || ''));
		element('discordAddSourceButton')?.addEventListener('click', addOrUpdateSource);
		modal.addEventListener('click', (event) => {
			if (event.target === modal) closeModal();
		});
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
		});
	}

	window.showDiscordAddSourcePrompt = showDiscordAddSourcePrompt;
	window.setupDiscordSourceControls = setupDiscordSourceControls;
	window.applyDiscordNativeSourceUI = applyDiscordNativeSourceUI;
	window.createDiscordNativeSource = async function (source) {
		const discord = bridge();
		if (!discord) throw new Error('The native Discord bridge is unavailable.');
		const result = resultValue(await discord.connectSource({
			sourceId: source.id,
			authRef: source.discordAuthRef,
			guildId: source.guildId,
			channelId: source.channelId,
			includeWebhookMessages: !!source.includeWebhookMessages,
			replyOnly: !!source.replyOnly,
			accountRole: source.accountRole,
			customSession: source.customSession,
		}));
		return result.virtualTabId;
	};

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeModal, { once: true });
	else initializeModal();

	if (bridge()) bridge().onStatus(handleConnectionStatus);
})();
