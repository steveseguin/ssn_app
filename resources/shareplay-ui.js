'use strict';

(function () {
	let modal;
	let sourceId = null;
	let accounts = [];
	let busy = false;
	let previousFocus;
	const TEST_CLIENT_ID = 'social_stream_ninja_test_bf18ab';
	const bridge = () => window.ninjafy.shareplay;
	const element = (id) => document.getElementById(id);

	function value(result) {
		if (!result?.success) throw new Error(result?.error?.message || 'SharePlay setup failed.');
		return result;
	}

	function status(message) { element('shareplayStatus').textContent = message; }
	function setBusy(next) {
		busy = next;
		for (const id of ['shareplaySignIn', 'shareplayAccount', 'shareplayClientId', 'shareplayClientSecret', 'shareplayAdd', 'shareplayForget']) element(id).disabled = next;
		element('shareplayAdd').disabled = next || !element('shareplayAccount').value;
		element('shareplayForget').disabled = next || !element('shareplayAccount').value;
	}

	function updateClientFields() {
		const isTest = element('shareplayClientId').value.trim() === TEST_CLIENT_ID;
		element('shareplayTestCredentials').hidden = !isTest;
		if (!isTest) element('shareplayClientSecret').value = '';
	}

	function markDisconnected(ids) {
		for (const id of ids || []) {
			if (stateManager.getSource(id)) stateManager.updateSource(id, { status: 'inactive', error: null, vid: null, wssId: null, activeConnectionMode: null });
		}
	}

	async function loadAccounts(preferred) {
		const result = value(await bridge().accounts());
		accounts = result.accounts;
		const select = element('shareplayAccount');
		select.replaceChildren(new Option(accounts.length ? 'Choose an account' : 'Sign in to add an account', ''));
		for (const account of accounts) select.appendChild(new Option(account.username, account.authRef));
		select.value = preferred || accounts[0]?.authRef || '';
		element('shareplayClientId').value = result.clientId || '';
		updateClientFields();
		element('shareplayDeveloperSetup').open = !result.clientId || result.clientId === TEST_CLIENT_ID;
		if (!result.clientId) status('SharePlay must issue SSN a public OAuth client ID before sign-in is available.');
		setBusy(false);
	}

	function close() {
		if (busy) bridge().cancelSignIn();
		element('shareplayClientSecret').value = '';
		modal.classList.add('hidden');
		previousFocus?.focus();
	}

	async function signIn() {
		try {
			setBusy(true);
			status('Complete SharePlay sign-in in your browser.');
			const payload = { clientId: element('shareplayClientId').value.trim(), clientSecret: element('shareplayClientSecret').value };
			element('shareplayClientSecret').value = '';
			const result = value(await bridge().signIn(payload));
			markDisconnected(result.affectedSourceIds);
			await loadAccounts(result.account.authRef);
			status(`Signed in as ${result.account.username}.`);
		} catch (error) { status(error.message); }
		finally { setBusy(false); }
	}

	async function forget() {
		const account = accounts.find((item) => item.authRef === element('shareplayAccount').value);
		if (!account || !window.confirm(`Forget the saved SharePlay sign-in for ${account.username}? Sources using it will stop.`)) return;
		try {
			setBusy(true);
			const result = value(await bridge().forget(account.authRef));
			markDisconnected(result.affectedSourceIds);
			await loadAccounts();
			status('Saved sign-in removed.');
		} catch (error) { status(error.message); }
		finally { setBusy(false); }
	}

	async function addSource() {
		const account = accounts.find((item) => item.authRef === element('shareplayAccount').value);
		if (!account) return;
		const data = {
			target: 'shareplay', username: account.username, url: `https://www.shareplay.tv/${encodeURIComponent(account.username)}`,
			shareplayNative: true, shareplayAuthRef: account.authRef, sourceFile: 'sources/shareplay.js',
			connectionMode: 'websocket', supportsWSS: true, isVisible: false, isMuted: true,
		};
		try {
			if (sourceId) {
				value(await bridge().disconnect(sourceId));
				stateManager.updateSource(sourceId, { ...data, status: 'inactive', error: null, vid: null, wssId: null, activeConnectionMode: null });
			} else {
				if (stateManager.getSources().some((source) => source.shareplayNative && source.shareplayAuthRef === account.authRef)) {
					status('This account already has a SharePlay source.');
					return;
				}
				stateManager.addSource({ ...data, autoActivate: false });
				if (typeof manageWelcomePage === 'function') manageWelcomePage();
			}
			close();
			Toast.success('SharePlay source ready', 'Activate the source to connect.');
		} catch (error) { status(error.message); }
	}

	function createModal() {
		modal = document.createElement('div');
		modal.id = 'shareplaySetupModal';
		modal.className = 'modal hidden';
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.setAttribute('aria-labelledby', 'shareplaySetupTitle');
		modal.innerHTML = `<div class="modal-content source-setup">
			<h2 id="shareplaySetupTitle">Connect SharePlay</h2>
			<p>Capture chat, emotes, replies, shoutouts, Blitz raids, and viewer counts from your own channel.</p>
			<button id="shareplaySignIn" type="button">Sign in with SharePlay</button>
			<label for="shareplayAccount">Saved account</label>
			<select id="shareplayAccount"></select>
			<details id="shareplayDeveloperSetup" class="source-setup-help">
				<summary>Developer setup</summary>
				<label for="shareplayClientId">OAuth client ID</label>
				<input id="shareplayClientId" type="text" autocomplete="off" spellcheck="false" aria-describedby="shareplayClientHelp">
				<p id="shareplayClientHelp">SSN's public client is ready to use. Change this only to test another client issued by SharePlay.</p>
				<div id="shareplayTestCredentials" hidden>
					<label for="shareplayClientSecret">Test client secret</label>
					<input id="shareplayClientSecret" type="password" autocomplete="off" aria-describedby="shareplaySecretHelp">
					<p id="shareplaySecretHelp">For local testing. Saved encrypted on this computer. Sign-in returns directly to the app over HTTP.</p>
				</div>
			</details>
			<p id="shareplayStatus" role="status" aria-live="polite"></p>
			<div class="source-setup-buttons">
				<button id="shareplayCancel" type="button" data-type="cancel">Cancel</button>
				<button id="shareplayForget" type="button" class="btn-secondary">Forget sign-in</button>
				<button id="shareplayAdd" type="button">Add source</button>
			</div>
		</div>`;
		document.body.appendChild(modal);
		element('shareplaySignIn').addEventListener('click', signIn);
		element('shareplayCancel').addEventListener('click', close);
		element('shareplayForget').addEventListener('click', forget);
		element('shareplayAdd').addEventListener('click', addSource);
		element('shareplayAccount').addEventListener('change', () => setBusy(busy));
		element('shareplayClientId').addEventListener('input', updateClientFields);
		modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
		modal.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') { event.preventDefault(); close(); }
			if (event.key !== 'Tab') return;
			const controls = [...modal.querySelectorAll('button, input, select, summary')].filter((node) => !node.disabled && node.getClientRects().length);
			const first = controls[0];
			const last = controls[controls.length - 1];
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
		});
	}

	window.showSharePlaySetup = async function (id = null) {
		if (!modal) createModal();
		if (busy) return;
		sourceId = id;
		previousFocus = document.activeElement;
		modal.classList.remove('hidden');
		element('shareplayAdd').textContent = id ? 'Save changes' : 'Add source';
		status('');
		try { await loadAccounts(id ? stateManager.getSource(id)?.shareplayAuthRef : ''); }
		catch (error) { status(error.message); }
		element('shareplaySignIn').focus();
	};

	window.applySharePlaySourceUI = function (entry, source) {
		if (!source.shareplayNative) return;
		for (const selector of ['[data-signin]', '[data-signin-chrome]', '[data-reloadhtml]', '[data-togglehtml]', '[data-togglemute]', '[data-clearcache]', '[data-reply-only]', '[data-account-role]', '.mode-selector', '.connection-modes', '.settings-menu-item[onclick^="openUserAgentSettings"]', '.settings-menu-item[onclick^="openSessionSettings"]']) {
			entry.querySelector(selector)?.classList.add('hidden');
		}
		const badge = entry.querySelector('[data-session-badge]');
		if (badge) { badge.textContent = 'SharePlay API'; badge.classList.remove('hidden'); }
		const setup = entry.querySelector('[data-showtips]');
		if (setup) {
			setup.classList.remove('hidden');
			setup.textContent = 'Setup';
			setup.onclick = () => window.showSharePlaySetup(source.id);
		}
	};

	window.createSharePlaySource = async function (source) {
		return value(await bridge().connect({ sourceId: source.id, authRef: source.shareplayAuthRef, replyOnly: !!source.replyOnly })).virtualTabId;
	};

	bridge()?.onStatus((update) => {
		const source = window.stateManager?.getSource(update.sourceId);
		if (!source?.shareplayNative) return;
		const entry = document.querySelector(`[data-source-id="${source.id}"]`);
		const connected = update.status === 'connected';
		const failed = update.status === 'error';
		stateManager.updateSource(source.id, {
			status: connected ? 'active' : failed ? 'error' : 'activating', error: failed ? update.message : null,
			vid: update.virtualTabId, wssId: update.virtualTabId, activeConnectionMode: 'websocket',
		});
		if (entry && typeof updateConnectionStatus === 'function') updateConnectionStatus(entry, connected ? 'connected' : failed ? 'error' : 'connecting', update.message);
	});
})();
