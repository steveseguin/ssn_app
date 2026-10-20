'use strict';

(function () {
	const $ = id => document.getElementById(id);
	const base = new URL('./', location.href);
	let instanceId = '', token = '', active = false, timer = null, shot = null, gesture = null;
	let queue = Promise.resolve(), actionPending = 0, refreshing = false, tick = 0, windowKey = '', pendingText = null;
	// Bridges may deliver a viewer-only credential in the URL fragment. It is
	// removed immediately and is never sent in a URL or kept in browser storage.
	const grant = new URLSearchParams(location.hash.slice(1));
	const initialToken = grant.get('token');
	const initialInstance = grant.get('instance');
	if (location.hash) history.replaceState(null, '', location.pathname + location.search);

	async function request(endpoint, body, privateRequest = true) {
		const headers = { 'X-SSApp-Instance-Id': instanceId };
		if (privateRequest && token) headers['X-SSApp-Human-Token'] = token;
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		const response = await fetch(new URL(endpoint, base), { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(30000) });
		const result = await response.json();
		if (!response.ok || !result.ok) throw Object.assign(new Error(result.error?.message || 'The request failed.'), { code: result.error?.code });
		return result;
	}
	function message(error) { $('message').textContent = error?.message || String(error || ''); }
	function command(action, value = {}) { return request('command', { action, value }); }
	function clearPicture() { shot = null; $('screen').hidden = true; $('screen').removeAttribute('src'); $('placeholder').hidden = false; }
	function stop(label) {
		active = false; token = ''; pendingText = null; clearTimeout(timer); gesture = null; clearPicture();
		$('text').value = ''; $('dialog-content').replaceChildren(); $('dialogs').hidden = true;
		$('viewer').hidden = true; $('welcome').hidden = false; $('state').textContent = label; $('start').disabled = false;
	}
	async function windows() {
		const result = await command('listBrowserTargets');
		if (!active) return;
		const targets = result.payload.targets;
		const signature = JSON.stringify(targets.map(t => [t.targetId, t.title, t.redactedUrl]));
		if (signature !== windowKey) {
			const selected = $('targets').value;
			$('targets').replaceChildren(...targets.map(t => { const option = document.createElement('option'); option.value = t.targetId; option.textContent = `${t.kind}: ${t.title || t.redactedUrl || t.targetId}`; option.dataset.origin = t.redactedUrl; return option; }));
			if (targets.some(t => t.targetId === selected)) $('targets').value = selected;
			else clearPicture();
			windowKey = signature;
		}
		if (!shot) $('origin').textContent = $('targets').selectedOptions[0]?.dataset.origin || 'Window closed';
	}
	async function dialogs() {
		const result = await command('getPendingAppDialogs');
		if (!active) return;
		const dialog = result.payload.dialogs[0];
		$('dialogs').hidden = !dialog;
		if (!dialog) { $('dialog-content').replaceChildren(); return; }
		if ($('dialog-content').dataset.id === dialog.dialogId && $('dialog-content').childNodes.length) return;
		$('dialog-content').dataset.id = dialog.dialogId;
		$('dialog-content').replaceChildren();
		message('Complete the browser prompt below.');
		const text = document.createElement('p'); text.textContent = dialog.message || dialog.title || 'Browser prompt'; $('dialog-content').append(text);
		let input;
		if (dialog.kind === 'prompt') { input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'off'; input.setAttribute('aria-label', 'Private prompt answer'); $('dialog-content').append(input); }
		(dialog.buttons || ['OK', 'Cancel']).forEach((label, buttonIndex) => {
			const button = document.createElement('button'); button.textContent = label;
			button.onclick = () => enqueue(async () => { const promptText = input?.value; if (input) input.value = ''; await command('respondToAppDialog', { dialogId: dialog.dialogId, accept: label !== 'Cancel', buttonIndex, ...(promptText !== undefined ? { promptText } : {}), confirm: true }); $('dialog-content').replaceChildren(); message(''); });
			$('dialog-content').append(button);
		});
	}
	async function poll() {
		if (!active) return;
		try {
			if (!document.hidden && !gesture && !actionPending && !refreshing) {
				refreshing = true;
				if (tick++ % 6 === 0) await windows();
				await dialogs();
				if (!$('dialogs').hidden) return;
				const targetId = $('targets').value;
				if (targetId && active) {
					const result = await command('captureBrowserScreenshot', { targetId, format: 'jpeg', maxWidth: 1280 });
					if (active && targetId === $('targets').value && !gesture && !actionPending) {
						const image = new Image(); image.src = `data:${result.payload.mimeType};base64,${result.payload.dataBase64}`;
						await image.decode();
						if (active && targetId === $('targets').value && !gesture && !actionPending) {
							shot = result.payload; $('screen').src = image.src; $('screen').hidden = false; $('placeholder').hidden = true;
							$('origin').textContent = shot.page?.redactedUrl || 'Address unavailable';
						}
					}
				}
			}
		} catch (error) {
			message(error);
			if (['HUMAN_CONTROL_UNAUTHORIZED', 'HUMAN_CONTROL_EXPIRED', 'SSAPP_INSTANCE_CHANGED'].includes(error.code) || !error.code) stop('Disconnected · AI remains paused');
		} finally { refreshing = false; if (active) timer = setTimeout(poll, 350); }
	}
	function enqueue(task) {
		if (!active) return;
		actionPending++;
		queue = queue.then(async () => { if (active) await task(); }).catch(error => { message(error); if (!error.code || ['HUMAN_CONTROL_UNAUTHORIZED', 'HUMAN_CONTROL_EXPIRED', 'SSAPP_INSTANCE_CHANGED'].includes(error.code)) stop('Disconnected · check session'); }).finally(() => actionPending--);
	}
	function input(actions, observed = shot) {
		if (!observed) return;
		// Hidden targets can take longer to prepare for input. Combine consecutive
		// characters that have not yet been dispatched, preserving all other ordering.
		const isText = actions.length === 1 && actions[0].action === 'type';
		if (isText && pendingText && pendingText.targetId === observed.targetId && pendingText.screenshotId === observed.screenshotId && pendingText.actions[0].text.length + actions[0].text.length <= 20000) {
			pendingText.actions[0].text += actions[0].text;
			return;
		}
		const value = { targetId: observed.targetId, screenshotId: observed.screenshotId, actions, confirm: true };
		pendingText = isText ? value : null;
		enqueue(() => { if (pendingText === value) pendingText = null; return command('browserInput', value); });
	}
	function point(event) {
		const bounds = $('screen').getBoundingClientRect();
		return { x: Math.max(0, Math.min(shot.width - 1, (event.clientX - bounds.left) * shot.width / bounds.width)), y: Math.max(0, Math.min(shot.height - 1, (event.clientY - bounds.top) * shot.height / bounds.height)) };
	}
	$('screen').addEventListener('pointerdown', event => {
		if (!shot || gesture || event.button > 2) return;
		event.preventDefault(); $('screen').focus({ preventScroll: true }); $('screen').setPointerCapture(event.pointerId);
		gesture = { shot, path: [point(event)], button: ['left', 'middle', 'right'][event.button], pointerId: event.pointerId };
	});
	$('screen').addEventListener('pointermove', event => { if (gesture?.pointerId === event.pointerId && gesture.path.length < 99) gesture.path.push(point(event)); });
	$('screen').addEventListener('pointerup', event => {
		if (!gesture || gesture.pointerId !== event.pointerId) return;
		const current = gesture; const last = point(event); gesture = null;
		const first = current.path[0];
		if (Math.hypot(last.x - first.x, last.y - first.y) > 5) input([{ action: 'drag', path: [...current.path, last], button: current.button }], current.shot);
		else input([{ action: 'click', ...last, button: current.button }], current.shot);
	});
	$('screen').addEventListener('pointercancel', () => { gesture = null; });
	$('screen').addEventListener('contextmenu', event => event.preventDefault());
	$('screen').addEventListener('wheel', event => { event.preventDefault(); if (shot) input([{ action: 'scroll', ...point(event), deltaX: event.deltaX, deltaY: event.deltaY }]); }, { passive: false });
	$('screen').addEventListener('keydown', event => {
		if (!shot || ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
		event.preventDefault();
		if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) input([{ action: 'type', text: event.key }]);
		else input([{ action: 'keypress', key: event.key, modifiers: [['Control', event.ctrlKey], ['Meta', event.metaKey], ['Alt', event.altKey], ['Shift', event.shiftKey]].filter(p => p[1]).map(p => p[0]) }]);
	});
	$('screen').addEventListener('paste', event => { event.preventDefault(); const text = event.clipboardData.getData('text/plain'); if (text) input([{ action: 'type', text }]); });
	$('send').onclick = () => { const text = $('text').value; $('text').value = ''; if (text) input([{ action: 'type', text }]); };
	['tab', 'enter', 'escape'].forEach(id => { $(id).onclick = () => input([{ action: 'keypress', key: id[0].toUpperCase() + id.slice(1) }]); });
	$('targets').onchange = () => { clearPicture(); gesture = null; tick = 0; $('origin').textContent = $('targets').selectedOptions[0]?.dataset.origin || ''; };
	$('refresh').onclick = () => enqueue(windows);
	['back', 'reload'].forEach(action => { $(action).onclick = () => { const targetId = $('targets').value; clearPicture(); enqueue(() => command('navigateBrowserTarget', { targetId, action, confirm: true })); }; });
	async function activate() {
		active = true; windowKey = ''; tick = 0; $('welcome').hidden = true; $('viewer').hidden = false;
		$('state').textContent = 'Private control · AI paused'; message(''); await windows(); poll();
	}
	$('start').onclick = async () => {
		$('start').disabled = true;
		try {
			const info = await request('../instance', undefined, false); instanceId = info.instanceId;
			const result = await request('start', { confirm: true }, false); token = result.payload.token; await activate();
		} catch (error) { message(error); $('start').disabled = false; }
	};
	async function leave(finish) {
		clearTimeout(timer); active = false; await queue;
		while (refreshing) await new Promise(resolve => setTimeout(resolve, 50));
		try { await request(finish ? 'finish' : 'suspend', { confirm: true }); stop(finish ? 'Control returned to AI' : 'Disconnected · AI paused'); }
		catch (error) { active = true; message(error); poll(); }
	}
	$('finish').onclick = () => leave(true); $('pause').onclick = () => leave(false);
	window.addEventListener('pagehide', () => {
		if (!active || !token) return;
		fetch(new URL('suspend', base), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SSApp-Human-Token': token, 'X-SSApp-Instance-Id': instanceId }, body: '{"confirm":true}', keepalive: true }).catch(() => {});
	});
	(async () => {
		try {
			const info = await request('../instance', undefined, false); instanceId = info.instanceId;
			if (initialToken && initialInstance === instanceId) { token = initialToken; await activate(); }
			else { $('state').textContent = info.humanControl?.automationPaused ? 'AI paused · reconnect to continue' : 'Ready'; $('start').disabled = false; }
		} catch (error) { message(error); $('state').textContent = 'SSApp unavailable'; }
	})();
}());
