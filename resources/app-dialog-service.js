'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redactUrl } = require('./source-observation-service');

const DIALOG_ACTIONS = new Set(['getPendingAppDialogs', 'waitForAppDialog', 'respondToAppDialog']);
const MAX_PENDING_DIALOGS = 20;
const MAX_PROMPT_TEXT = 2000;
const MAX_PATHS = 20;
const MAX_WAIT_MS = 25000;
const ARM_DURATION_MS = 2 * 60 * 1000;

// The renderer keeps alert/confirm/prompt synchronous, but the main process stays free to
// serve MCP. The matching IPC reply is supplied only after MCP answers the pending dialog.
const JS_DIALOG_WRAPPER_SCRIPT = `(${function installAutomationDialogHooks() {
	if (window.__ssappAutomationDialogHooksInstalled) return true;
	window.__ssappAutomationDialogHooksInstalled = true;
	for (const name of ['alert', 'confirm', 'prompt']) {
		const original = window[name];
		if (typeof original !== 'function') continue;
		window[name] = function (...args) {
			let response = null;
			try { response = window.ninjafy?.requestAutomationJavaScriptDialog?.({ type: name, message: String(args[0] || '') }); } catch (_) { }
			if (!response || response.intercepted !== true) return original.apply(this, args);
			if (name === 'alert') return undefined;
			if (name === 'confirm') return response.accepted === true;
			return response.accepted === true ? String(response.promptText || '') : null;
		};
	}
	return true;
}.toString()})()`;

function controlError(code, message) {
	return { ok: false, error: { code, message } };
}

function clean(value, maximum = 4000) {
	return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function usableWindow(window) {
	try {
		return !!window && !window.isDestroyed() && !!window.webContents && !window.webContents.isDestroyed();
	} catch (_) {
		return false;
	}
}

function parseDialogArgs(args) {
	const options = args.length > 1 ? args[1] : args[0];
	return options && typeof options === 'object' ? options : {};
}

const RENDER_DIALOG_SCRIPT = `(${function renderAutomationDialog(config) {
	const existing = document.getElementById('__ssapp-automation-dialog-overlay');
	if (existing) existing.remove();
	const overlay = document.createElement('div');
	overlay.id = '__ssapp-automation-dialog-overlay';
	overlay.setAttribute('role', 'presentation');
	overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:24px;';
	const panel = document.createElement('section');
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-modal', 'true');
	panel.setAttribute('aria-label', config.title || 'SSApp prompt');
	panel.style.cssText = 'width:min(620px,95vw);max-height:90vh;overflow:auto;background:#20242b;color:#fff;border:1px solid #596273;border-radius:10px;padding:20px;box-shadow:0 18px 60px rgba(0,0,0,.55);font:14px/1.45 system-ui,sans-serif;';
	const heading = document.createElement('h2');
	heading.textContent = config.title || 'SSApp prompt';
	heading.style.cssText = 'margin:0 0 12px;font-size:20px;';
	panel.appendChild(heading);
	for (const value of [config.message, config.detail]) {
		if (!value) continue;
		const paragraph = document.createElement('p');
		paragraph.textContent = value;
		paragraph.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;';
		panel.appendChild(paragraph);
	}
	let pathInput = null;
	if (config.pathEntry) {
		const label = document.createElement('label');
		label.textContent = config.multiple ? 'File or folder paths, one per line' : 'File or folder path';
		label.style.cssText = 'display:block;margin:14px 0 5px;';
		pathInput = config.multiple ? document.createElement('textarea') : document.createElement('input');
		if (!config.multiple) pathInput.type = 'text';
		pathInput.setAttribute('aria-label', label.textContent);
		pathInput.placeholder = config.placeholder || '';
		pathInput.value = config.defaultPath || '';
		pathInput.style.cssText = 'box-sizing:border-box;width:100%;min-height:38px;padding:8px;background:#11151a;color:#fff;border:1px solid #697386;border-radius:5px;';
		label.appendChild(pathInput);
		panel.appendChild(label);
	}
	let checkbox = null;
	if (config.checkboxLabel) {
		const label = document.createElement('label');
		label.style.cssText = 'display:flex;gap:8px;align-items:center;margin:14px 0;';
		checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = config.checkboxChecked === true;
		label.append(checkbox, document.createTextNode(config.checkboxLabel));
		panel.appendChild(label);
	}
	const error = document.createElement('div');
	error.id = '__ssapp-automation-dialog-error';
	error.setAttribute('role', 'alert');
	error.style.cssText = 'display:none;color:#ffb4b4;margin-top:10px;';
	panel.appendChild(error);
	const buttons = document.createElement('div');
	buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:18px;';
	const send = response => {
		if (!window.ninjafy || typeof window.ninjafy.respondAutomationDialog !== 'function') return;
		window.ninjafy.respondAutomationDialog({ dialogId: config.dialogId, ...response });
	};
	(config.buttons || ['OK']).forEach((label, buttonIndex) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.setAttribute('aria-label', label);
		button.style.cssText = 'padding:8px 14px;border:1px solid #768094;border-radius:5px;background:#343b47;color:#fff;cursor:pointer;';
		button.addEventListener('click', () => {
			const paths = pathInput ? pathInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : undefined;
			send({ accept: config.buttons.length === 1 || buttonIndex !== config.cancelId, buttonIndex, paths, checkboxChecked: checkbox ? checkbox.checked : false });
		});
		buttons.appendChild(button);
	});
	panel.appendChild(buttons);
	overlay.appendChild(panel);
	document.body.appendChild(overlay);
	if (pathInput) pathInput.focus();
	else (buttons.querySelectorAll('button')[config.defaultId] || buttons.querySelector('button'))?.focus();
	return true;
}.toString()})`;

class AppDialogService {
	constructor(options = {}) {
		this.getMainWindow = options.getMainWindow || (() => null);
		this.publish = options.publish || (() => {});
		this.rememberApprovedPath = options.rememberApprovedPath || (() => {});
		this.pending = new Map();
		this.waiters = new Set();
		this.trackedWebContents = new Map();
		this.sequence = 0;
		this.originals = null;
		this.armedUntil = 0;
	}

	handles(action) {
		return DIALOG_ACTIONS.has(action);
	}

	arm() {
		// Normal SSApp dialogs are untouched until an MCP UI/dialog action starts a short session.
		this.armedUntil = Date.now() + ARM_DURATION_MS;
	}

	isArmed() {
		return this.pending.size > 0 || Date.now() < this.armedUntil;
	}

	install(dialog) {
		if (this.originals) return;
		this.originals = {
			dialog,
			showMessageBox: dialog.showMessageBox.bind(dialog),
			showOpenDialog: dialog.showOpenDialog.bind(dialog),
			showSaveDialog: dialog.showSaveDialog.bind(dialog),
			showErrorBox: dialog.showErrorBox.bind(dialog),
		};
		dialog.showMessageBox = (...args) => this.openNative('message', args, this.originals.showMessageBox);
		dialog.showOpenDialog = (...args) => this.openNative('open', args, this.originals.showOpenDialog);
		dialog.showSaveDialog = (...args) => this.openNative('save', args, this.originals.showSaveDialog);
		dialog.showErrorBox = (title, content) => {
			if (!this.canRender()) return this.originals.showErrorBox(title, content);
			void this.openNative('message', [{ title, message: content, buttons: ['OK'] }], this.originals.showMessageBox);
		};
	}

	canRender() {
		return this.isArmed() && usableWindow(this.getMainWindow()) && this.pending.size < MAX_PENDING_DIALOGS;
	}

	publicDialog(record) {
		return {
			dialogId: record.id,
			sequence: record.sequence,
			origin: record.origin,
			kind: record.kind,
			title: record.title,
			message: record.message,
			detail: record.detail,
			buttons: record.buttons,
			checkboxLabel: record.checkboxLabel || '',
			allowsPathEntry: record.kind === 'open' || record.kind === 'save',
			allowsMultiplePaths: record.multiple === true,
			openedAt: record.openedAt,
			windowId: record.windowId,
			redactedUrl: record.redactedUrl || '',
		};
	}

	notifyOpened(record) {
		const dialog = this.publicDialog(record);
		this.publish('app.dialog.opened', dialog);
		for (const waiter of Array.from(this.waiters)) {
			if (record.sequence <= waiter.afterId) continue;
			waiter.resolve();
		}
	}

	createRecord(values) {
		const record = {
			...values,
			id: `dlg_${crypto.randomUUID().replace(/-/g, '')}`,
			sequence: ++this.sequence,
			openedAt: new Date().toISOString(),
		};
		this.pending.set(record.id, record);
		this.notifyOpened(record);
		return record;
	}

	async openNative(kind, args, fallback) {
		if (!this.canRender()) return fallback(...args);
		const options = parseDialogArgs(args);
		const mainWindow = this.getMainWindow();
		const buttons = kind === 'message'
			? (Array.isArray(options.buttons) && options.buttons.length ? options.buttons.map(value => clean(value, 200)) : ['OK'])
			: ['Cancel', kind === 'save' ? 'Save' : 'Select'];
		const cancelId = Number.isInteger(options.cancelId) ? options.cancelId : (kind === 'message' ? buttons.length - 1 : 0);
		const defaultId = Number.isInteger(options.defaultId) ? options.defaultId : (kind === 'message' ? 0 : 1);
		return new Promise((resolve, reject) => {
			const record = this.createRecord({
				origin: 'electron', kind, resolve, reject, fallback: () => fallback(...args),
				title: clean(options.title || (kind === 'save' ? 'Save file' : kind === 'open' ? 'Choose file or folder' : 'SSApp prompt'), 500),
				message: clean(options.message, 4000), detail: clean(options.detail, 4000), buttons,
				checkboxLabel: clean(options.checkboxLabel, 500), checkboxChecked: options.checkboxChecked === true,
				cancelId: Math.max(0, Math.min(buttons.length - 1, cancelId)),
				defaultId: Math.max(0, Math.min(buttons.length - 1, defaultId)),
				defaultPath: typeof options.defaultPath === 'string' ? options.defaultPath : '',
				properties: Array.isArray(options.properties) ? options.properties : [],
				multiple: Array.isArray(options.properties) && options.properties.includes('multiSelections'),
				windowId: mainWindow.id,
			});
			void this.render(record);
		});
	}

	async render(record) {
		const window = this.getMainWindow();
		if (!usableWindow(window)) return this.fallback(record);
		const config = {
			dialogId: record.id, title: record.title, message: record.message, detail: record.detail,
			buttons: record.buttons, cancelId: record.cancelId, defaultId: record.defaultId,
			checkboxLabel: record.checkboxLabel, checkboxChecked: record.checkboxChecked,
			pathEntry: record.kind === 'open' || record.kind === 'save', multiple: record.multiple,
			defaultPath: record.defaultPath, placeholder: record.kind === 'save' ? 'C:\\path\\to\\file' : 'C:\\path\\to\\file-or-folder',
		};
		try {
			await window.webContents.executeJavaScript(`${RENDER_DIALOG_SCRIPT}(${JSON.stringify(config)})`, true);
		} catch (_) {
			await this.fallback(record);
		}
	}

	async fallback(record) {
		if (!this.pending.has(record.id)) return;
		this.pending.delete(record.id);
		try { record.resolve(await record.fallback()); } catch (error) { record.reject(error); }
	}

	async trackWindow(window) {
		if (!usableWindow(window) || this.trackedWebContents.has(window.webContents.id)) return;
		const wc = window.webContents;
		const install = () => void wc.executeJavaScript(JS_DIALOG_WRAPPER_SCRIPT, true).catch(() => {});
		const destroy = () => {
			this.trackedWebContents.delete(wc.id);
			const record = Array.from(this.pending.values()).find(item => item.origin === 'javascript' && item.webContentsId === wc.id);
			if (record) this.pending.delete(record.id);
		};
		wc.on('did-finish-load', install);
		wc.once('destroyed', destroy);
		this.trackedWebContents.set(wc.id, { wc, windowId: window.id, install, destroy });
		install();
	}

	handleSyncRendererJavaScriptDialog(event, value = {}) {
		if (!this.isArmed()) {
			event.returnValue = { intercepted: false };
			return;
		}
		const tracked = this.trackedWebContents.get(event.sender.id);
		if (!tracked || this.pending.size >= MAX_PENDING_DIALOGS) {
			event.returnValue = { intercepted: false };
			return;
		}
		const existing = Array.from(this.pending.values()).find(record => record.origin === 'javascript' && record.webContentsId === event.sender.id);
		if (existing) {
			event.returnValue = { intercepted: false };
			return;
		}
		this.createRecord({
			origin: 'javascript', kind: clean(value.type, 30) || 'alert', title: 'JavaScript prompt',
			message: clean(value.message, 4000), detail: '', buttons: value.type === 'alert' ? ['OK'] : ['Cancel', 'OK'],
			checkboxLabel: '', multiple: false, windowId: tracked.windowId, webContentsId: event.sender.id,
			// Electron keeps sendSync waiting while the main event loop continues serving MCP.
			resolve: response => { event.returnValue = { intercepted: true, ...response }; },
			redactedUrl: redactUrl(event.sender.getURL()),
		});
	}

	pendingResult() {
		return { dialogs: Array.from(this.pending.values()).map(record => this.publicDialog(record)), cursor: this.sequence };
	}

	async wait(value = {}) {
		const afterId = Number.isInteger(value.afterId) && value.afterId >= 0 ? value.afterId : 0;
		if (Array.from(this.pending.values()).some(record => record.sequence > afterId)) return this.pendingResult();
		const timeoutMs = Number.isInteger(value.timeoutMs) ? Math.max(1, Math.min(MAX_WAIT_MS, value.timeoutMs)) : 15000;
		await new Promise(resolve => {
			const waiter = { afterId, resolve: null };
			const finish = () => { clearTimeout(timer); this.waiters.delete(waiter); resolve(); };
			waiter.resolve = finish;
			const timer = setTimeout(finish, timeoutMs);
			this.waiters.add(waiter);
		});
		return this.pendingResult();
	}

	normalizePaths(record, value) {
		const supplied = Array.isArray(value.paths) ? value.paths : [];
		const paths = supplied.map(item => String(item || '').trim()).filter(Boolean).map(item => path.resolve(item));
		if (!paths.length) return controlError('DIALOG_PATH_REQUIRED', 'Accepting this dialog requires a path.');
		if (paths.length > MAX_PATHS || (!record.multiple && paths.length > 1)) return controlError('INVALID_DIALOG_RESPONSE', 'Too many paths were supplied.');
		if (record.kind === 'open') {
			for (const selected of paths) {
				if (!fs.existsSync(selected)) return controlError('DIALOG_PATH_NOT_FOUND', 'A selected path does not exist.');
				const stat = fs.statSync(selected);
				if (record.properties.includes('openDirectory') && !record.properties.includes('openFile') && !stat.isDirectory()) {
					return controlError('INVALID_DIALOG_PATH', 'This dialog requires a folder.');
				}
				if (!record.properties.includes('openDirectory') && stat.isDirectory()) return controlError('INVALID_DIALOG_PATH', 'This dialog requires a file.');
			}
		} else {
			const parent = path.dirname(paths[0]);
			if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return controlError('DIALOG_PATH_NOT_FOUND', 'The save folder does not exist.');
		}
		return { ok: true, paths };
	}

	async respond(record, value) {
		const accept = value.accept === true;
		if (record.origin === 'javascript') {
			const promptText = String(value.promptText || '');
			if (promptText.length > MAX_PROMPT_TEXT) return controlError('INVALID_DIALOG_RESPONSE', `Prompt text must be ${MAX_PROMPT_TEXT} characters or fewer.`);
			this.pending.delete(record.id);
			record.resolve({ accepted: accept, promptText });
			this.publish('app.dialog.closed', { dialogId: record.id, accepted: accept, origin: record.origin, kind: record.kind });
			return { ok: true, payload: { dialogId: record.id, handled: true, accepted: accept } };
		}

		let result;
		if (record.kind === 'message') {
			const requested = Number(value.buttonIndex);
			const response = accept
				? (Number.isInteger(requested) && requested >= 0 && requested < record.buttons.length ? requested : record.defaultId)
				: record.cancelId;
			result = { response, checkboxChecked: value.checkboxChecked === true };
		} else if (!accept) {
			result = record.kind === 'save' ? { canceled: true, filePath: undefined } : { canceled: true, filePaths: [] };
		} else {
			const normalized = this.normalizePaths(record, value);
			if (!normalized.ok) return normalized;
			for (const selected of normalized.paths) this.rememberApprovedPath(selected);
			result = record.kind === 'save'
				? { canceled: false, filePath: normalized.paths[0] }
				: { canceled: false, filePaths: normalized.paths };
		}
		this.pending.delete(record.id);
		record.resolve(result);
		this.publish('app.dialog.closed', { dialogId: record.id, accepted: accept, origin: record.origin, kind: record.kind });
		const window = this.getMainWindow();
		if (usableWindow(window)) {
			void window.webContents.executeJavaScript(`document.getElementById('__ssapp-automation-dialog-overlay')?.remove(); true`, true).catch(() => {});
		}
		return { ok: true, payload: { dialogId: record.id, handled: true, accepted: accept, result } };
	}

	async handleRendererResponse(event, value = {}) {
		const record = this.pending.get(String(value.dialogId || ''));
		if (!record || record.origin !== 'electron') return;
		const mainWindow = this.getMainWindow();
		if (!usableWindow(mainWindow) || event.sender.id !== mainWindow.webContents.id) return;
		const response = await this.respond(record, value);
		if (!response.ok) {
			void mainWindow.webContents.executeJavaScript(`(() => { const element = document.getElementById('__ssapp-automation-dialog-error'); if (!element) return false; element.textContent = ${JSON.stringify(response.error.message)}; element.style.display = 'block'; return true; })()`, true).catch(() => {});
		}
	}

	async execute(action, value = {}) {
		this.arm();
		if (action === 'getPendingAppDialogs') return { ok: true, payload: this.pendingResult() };
		if (action === 'waitForAppDialog') return { ok: true, payload: await this.wait(value) };
		if (action === 'respondToAppDialog') {
			if (typeof value.accept !== 'boolean') return controlError('INVALID_DIALOG_RESPONSE', 'accept must be true or false.');
			const record = this.pending.get(String(value.dialogId || ''));
			if (!record) return controlError('APP_DIALOG_NOT_FOUND', 'The dialog is no longer pending. Read pending dialogs again.');
			return this.respond(record, value);
		}
		return controlError('UNSUPPORTED_ACTION', 'Unsupported app-dialog action.');
	}

	close() {
		for (const waiter of Array.from(this.waiters)) waiter.resolve();
		for (const record of this.pending.values()) {
			if (record.origin === 'electron') record.resolve(record.kind === 'message' ? { response: record.cancelId, checkboxChecked: false } : record.kind === 'save' ? { canceled: true, filePath: undefined } : { canceled: true, filePaths: [] });
			else if (record.origin === 'javascript') record.resolve({ accepted: false, promptText: '' });
		}
		this.pending.clear();
		for (const tracked of this.trackedWebContents.values()) {
			try { tracked.wc.removeListener('did-finish-load', tracked.install); } catch (_) { }
			try { tracked.wc.removeListener('destroyed', tracked.destroy); } catch (_) { }
		}
		this.trackedWebContents.clear();
		if (this.originals) {
			const { dialog } = this.originals;
			dialog.showMessageBox = this.originals.showMessageBox;
			dialog.showOpenDialog = this.originals.showOpenDialog;
			dialog.showSaveDialog = this.originals.showSaveDialog;
			dialog.showErrorBox = this.originals.showErrorBox;
		}
	}
}

module.exports = { AppDialogService };
