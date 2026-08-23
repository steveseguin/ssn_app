#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const electronPath = require('electron');
const appRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(appRoot, '..', 'social_stream');
const screenshotDirectory = process.env.SSAPP_TRANSLATION_SCREENSHOT_DIR || path.join(appRoot, 'artifacts', 'translation-layout');
const locales = ['ar', 'cs', 'de', 'en-uk', 'en-us', 'es', 'fr', 'pt-br', 'test', 'th', 'tr', 'uk', 'zh-CN', 'zh-TW'];
const layoutKeys = [
	'auto-queue-superchats',
	'leaderboard-showcase-settings',
	'leaderboard-showcase-note',
	'continuously-save-current-live-stats-by-platform'
];
const translationsByLocale = Object.fromEntries(locales.map(locale => [
	locale,
	JSON.parse(fs.readFileSync(path.join(socialStreamRoot, 'translations', `${locale}.json`), 'utf8'))
]));

function delay(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function getFreePort() {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

async function requestJson(port, token, pathname, body) {
	const separator = pathname.includes('?') ? '&' : '?';
	const response = await fetch(
		`http://127.0.0.1:${port}${pathname}${separator}token=${encodeURIComponent(token)}`,
		body === undefined ? undefined : {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}
	);
	const payload = await response.json();
	if (!response.ok || payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`);
	return payload;
}

async function waitFor(check, label, timeoutMilliseconds = 60000) {
	const deadline = Date.now() + timeoutMilliseconds;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const result = await check();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await delay(100);
	}
	throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

function createMcpSession(port) {
	const child = spawn(process.execPath, [path.join(appRoot, 'resources', 'ssapp-mcp.js')], {
		cwd: appRoot,
		env: { ...process.env, SSAPP_CONTROL_URL: `http://127.0.0.1:${port}` },
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true
	});
	let nextId = 1;
	let stderr = '';
	let buffer = '';
	const responses = new Map();
	child.stderr.on('data', chunk => { stderr += chunk.toString(); });
	child.stdout.on('data', chunk => {
		buffer += chunk.toString();
		let newline;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const response = JSON.parse(line);
			responses.set(response.id, response);
		}
	});
	const request = async (method, params = {}, timeoutMilliseconds = 40000) => {
		const id = nextId++;
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		const deadline = Date.now() + timeoutMilliseconds;
		while (Date.now() < deadline) {
			if (responses.has(id)) {
				const response = responses.get(id);
				responses.delete(id);
				return response;
			}
			if (child.exitCode !== null) throw new Error(`MCP exited (${child.exitCode}): ${stderr}`);
			await delay(25);
		}
		throw new Error(`Timed out waiting for MCP ${method}: ${stderr}`);
	};
	const call = async (name, args = {}) => {
		const response = await request('tools/call', { name, arguments: args });
		assert.ok(!response.error, `${name}: ${JSON.stringify(response)}`);
		assert.notStrictEqual(response.result?.isError, true, `${name}: ${JSON.stringify(response.result)}`);
		return response.result;
	};
	const close = async () => {
		if (!child.stdin.writableEnded) child.stdin.end();
		await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
		if (child.exitCode === null) child.kill();
	};
	return { request, call, close };
}

function payloadOf(toolResult) {
	const result = toolResult?.structuredContent?.result || toolResult?.structuredContent || {};
	return result.payload || result.result?.payload || {};
}

async function run() {
	const controlPort = await getFreePort();
	const token = `translation-layout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-translation-layout-'));
	const sourceUrl = pathToFileURL(`${socialStreamRoot}${path.sep}`).href;
	const child = spawn(electronPath, [
		'.',
		'--running-from-source',
		'--multiinstance',
		'--filesource',
		sourceUrl,
		'--remote-control',
		'--ssapp-control-api',
		'--ssapp-headless-control',
		`--ssapp-control-port=${controlPort}`,
		'--no-hwa',
		...linuxLaunchArgs()
	], {
		cwd: appRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDirectory,
			SSAPP_REMOTE_CONTROL: '1',
			SSAPP_REMOTE_CONTROL_PORT: String(controlPort),
			SSAPP_REMOTE_CONTROL_TOKEN: token,
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: '0'
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	});

	let stdout = '';
	let stderr = '';
	child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-30000); });
	child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-30000); });
	const request = (pathname, body) => requestJson(controlPort, token, pathname, body);
	const mcp = createMcpSession(controlPort);

	try {
		await waitFor(async () => {
			try {
				return (await request('/ping')).ok;
			} catch (_) {
				return false;
			}
		}, 'SSApp startup');

		const mainWindow = await waitFor(async () => {
			const windows = (await request('/windows')).windows || [];
			return windows.find(windowInfo => String(windowInfo.url || '').includes('index.html')) || false;
		}, 'SSApp main window');
		const execute = async code => (await request('/exec', { windowId: mainWindow.id, code })).result;

		await mcp.request('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'ssapp-translation-layout-e2e', version: '1.0.0' }
		});
		const appWindow = (payloadOf(await mcp.call('ssapp_list_app_windows')).windows || [])
			.find(windowInfo => windowInfo.kind === 'main');
		assert.ok(appWindow?.windowId, 'MCP did not report the main SSApp window');

		const captureScreenshot = async suffix => {
			fs.mkdirSync(screenshotDirectory, { recursive: true });
			const screenshot = await mcp.call('ssapp_capture_app_window_screenshot', {
				windowId: appWindow.windowId,
				format: 'png',
				maxWidth: 1400
			});
			const image = (screenshot.content || []).find(item => item.type === 'image' && item.mimeType === 'image/png');
			assert.ok(image?.data, 'MCP did not return a PNG screenshot');
			const screenshotPath = path.join(screenshotDirectory, `${suffix}.png`);
			fs.writeFileSync(screenshotPath, Buffer.from(image.data, 'base64'));
			console.log(`Saved translation screenshot: ${screenshotPath}`);
		};

		await waitFor(async () => await execute(`(() => {
			return !!(window.stateManager?.initialized &&
				typeof config !== 'undefined' && config &&
				typeof manifest !== 'undefined' && manifest &&
				document.getElementById('frame2')?.src &&
				document.readyState === 'complete');
		})()`), 'SSApp application initialization');
		await delay(1000);

		await execute(`(async () => {
			localStorage.setItem('popupCollapsed', 'false');
			document.body.classList.remove('overlay-collapsed');
			document.body.classList.add('overlay-expanded');
			document.querySelector('#main-navigation a[data-page="streams"]')?.click();
			await ensurePopupPanelLoaded();
			const panel = document.getElementById('link-overlay-page');
			panel.style.setProperty('display', 'block', 'important');
			panel.style.setProperty('width', '400px', 'important');
			panel.style.setProperty('min-width', '400px', 'important');
			return true;
		})()`);

		for (const locale of locales) {
			await execute(`changeLanguage(${JSON.stringify(locale)}, { source: 'translation-layout-e2e' }); true`);
			const expectedLanguage = locale === 'en-uk' ? 'en-GB' : locale;
			const languageState = await waitFor(async () => await execute(`(() => {
				const frame = document.getElementById('frame1');
				const panel = document.getElementById('link-overlay-page');
				if (!frame || !panel) return null;
				const doc = frame?.contentDocument;
				if (!doc?.body || doc.readyState !== 'complete') return null;
				if (String(doc.documentElement.lang || '').toLowerCase() !== ${JSON.stringify(expectedLanguage.toLowerCase())}) return null;
				const keys = ${JSON.stringify(layoutKeys)};
				const elements = keys.map(key => doc.querySelector('[data-translate="' + key + '"]'));
				if (elements.some(element => !element || !String(element.textContent || '').trim())) return null;
				return {
					language: doc.documentElement.lang,
					direction: doc.documentElement.dir || frame.contentWindow.getComputedStyle(doc.documentElement).direction,
					frameWidth: frame.getBoundingClientRect().width,
					panelWidth: panel.getBoundingClientRect().width,
					panelStyle: panel.getAttribute('style'),
					panelDisplay: getComputedStyle(panel).display,
					contentPaneDisplay: getComputedStyle(document.getElementById('content-pane')).display,
					contentPaneWidth: document.getElementById('content-pane').getBoundingClientRect().width,
					bodyClass: document.body.className,
					texts: elements.map(element => String(element.textContent || '').trim())
				};
			})()`), `${locale} popup translation`);

			assert.strictEqual(languageState.language.toLowerCase(), expectedLanguage.toLowerCase(), `${locale} did not set popup language`);
			assert.strictEqual(languageState.direction, locale === 'ar' ? 'rtl' : 'ltr', `${locale} used the wrong reading direction`);
			assert.ok(languageState.frameWidth >= 300,
				`${locale} popup was not visibly expanded: ${JSON.stringify(languageState)}`);
			assert.ok(languageState.texts.every(Boolean), `${locale} left one of the current settings blank`);
			await execute(`(() => {
				const frameWindow = document.getElementById('frame1')?.contentWindow;
				if (typeof frameWindow?.applyPopupBeginnerMode !== 'function') return false;
				frameWindow.applyPopupBeginnerMode(false);
				return true;
			})()`);

			for (const key of layoutKeys) {
				await execute(`(() => {
					const doc = document.getElementById('frame1').contentDocument;
					const target = doc.querySelector('[data-translate=${JSON.stringify(key)}]');
					const collapsible = target?.closest('.collapsible');
					const input = collapsible?.querySelector(':scope > input.collapsible-input');
					if (!target || !input) return false;
					input.checked = true;
					input.dispatchEvent(new Event('change', { bubbles: true }));
					target.scrollIntoView({ block: 'center', inline: 'nearest' });
					return true;
				})()`);
				await delay(500);
				const layout = await waitFor(async () => await execute(`(() => {
					const frame = document.getElementById('frame1');
					const doc = frame?.contentDocument;
					const element = doc?.querySelector('[data-translate=${JSON.stringify(key)}]');
					if (!element) return null;
					const rect = element.getBoundingClientRect();
					const clipped = [];
					const ancestors = [];
					let parent = element.parentElement;
					while (parent && parent !== doc.body) {
						const style = frame.contentWindow.getComputedStyle(parent);
						const parentRect = parent.getBoundingClientRect();
						ancestors.push({ tag: parent.tagName, id: parent.id, className: parent.className, display: style.display, width: parentRect.width });
						if (parentRect.width > 2 && ['hidden', 'clip'].includes(style.overflowX) &&
							(rect.left < parentRect.left - 1 || rect.right > parentRect.right + 1)) {
							clipped.push(parent.tagName + '.' + parent.className);
						}
						parent = parent.parentElement;
					}
					const viewportWidth = doc.documentElement.clientWidth;
					const overflowingElements = Array.from(doc.body.querySelectorAll('*')).map(candidate => {
						const candidateRect = candidate.getBoundingClientRect();
						return { candidate, candidateRect };
					}).filter(item => item.candidateRect.width > 2 &&
						(item.candidateRect.left < -2 || item.candidateRect.right > viewportWidth + 2))
						.slice(0, 12).map(item => ({
							tag: item.candidate.tagName,
							id: item.candidate.id,
							className: item.candidate.className,
							key: item.candidate.dataset?.translate || '',
							left: Math.round(item.candidateRect.left),
							right: Math.round(item.candidateRect.right),
							width: Math.round(item.candidateRect.width),
							text: String(item.candidate.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
						}));
					return {
						text: String(element.textContent || '').trim(),
						rect: { left: rect.left, right: rect.right, width: rect.width, height: rect.height },
						ancestors,
						clipped,
						overflowingElements,
						horizontalOverflow: doc.documentElement.scrollWidth - doc.documentElement.clientWidth
					};
				})()`), `${locale} ${key} visible layout`);
				assert.ok(layout.text, `${locale} ${key} rendered blank`);
				assert.ok(layout.rect.width >= 2 && layout.rect.height >= 2,
					`${locale} ${key} was not visible: ${JSON.stringify(layout.ancestors)}`);
				assert.deepStrictEqual(layout.clipped, [], `${locale} ${key} was horizontally clipped by ${layout.clipped.join(', ')}`);
				assert.ok(layout.horizontalOverflow <= 20,
					`${locale} ${key} overflowed the popup by ${layout.horizontalOverflow}px: ${JSON.stringify(layout.overflowingElements)}`);
			}

			const fileStatus = await execute(`(() => {
				const doc = document.getElementById('frame1')?.contentDocument;
				const status = doc?.querySelector('[data-handle-status="liveStats"]');
				const group = status?.closest('.options_group');
				const controls = Array.from(group?.querySelectorAll('.grid .glowingButton, .grid3 .glowingButton') || []).map(button => {
					const label = button.querySelector('[data-translate]') || button;
					const labelRect = label.getBoundingClientRect();
					return {
						text: String(label.textContent || '').trim(),
						labelWidth: label.clientWidth,
						labelScrollWidth: label.scrollWidth,
						labelHeight: label.clientHeight,
						labelScrollHeight: label.scrollHeight,
						labelRectWidth: labelRect.width,
						labelRectHeight: labelRect.height,
						buttonWidth: button.clientWidth,
						buttonScrollWidth: button.scrollWidth,
						buttonHeight: button.clientHeight,
						buttonScrollHeight: button.scrollHeight
					};
				});
				return status ? {
					label: String(status.querySelector('.status-label')?.textContent || '').trim(),
					detail: String(status.querySelector('.status-detail')?.textContent || '').trim(),
					controls
				} : null;
			})()`);
			const localeTranslations = translationsByLocale[locale].innerHTML;
			assert.strictEqual(fileStatus.label, localeTranslations['file-status-none'], `${locale} file status label was not translated`);
			assert.strictEqual(fileStatus.detail, localeTranslations['file-status-help-live-stats'], `${locale} file status help was not translated`);
			assert.deepStrictEqual(fileStatus.controls.filter(control =>
				control.buttonScrollWidth > control.buttonWidth + 1 || control.buttonScrollHeight > control.buttonHeight + 1 ||
				control.labelRectWidth > control.buttonWidth + 1 || control.labelRectHeight > control.buttonHeight + 1), [],
				`${locale} file action buttons truncated: ${JSON.stringify(fileStatus.controls)}`);

			if (['ar', 'de', 'pt-br', 'zh-CN'].includes(locale)) {
				await delay(250);
				await captureScreenshot(`popup-${locale}`);
			}
		}

		await execute(`changeLanguage('ar', { source: 'translation-layout-e2e' }); true`);
		await waitFor(async () => await execute(`(() => {
			const doc = document.getElementById('frame1')?.contentDocument;
			return String(doc?.documentElement.lang || '').toLowerCase() === 'ar';
		})()`), 'Arabic app language before Events Dashboard');
		await execute(`(() => {
			const frame = document.getElementById('frame1');
			frame.src = new URL('events.html?ln=ar', frame.src).href;
			return true;
		})()`);
		const dashboard = await waitFor(async () => await execute(`(() => {
			const frame = document.getElementById('frame1');
			const doc = frame?.contentDocument;
			if (!doc?.body || doc.readyState !== 'complete') return null;
			const headers = Array.from(doc.querySelectorAll('#header h1')).map(element => element.textContent.trim());
			if (headers.length < 2 || headers.some(header => !header)) return null;
			return {
				title: doc.title,
				headers,
				language: doc.documentElement.lang,
				direction: doc.documentElement.dir,
				horizontalOverflow: doc.documentElement.scrollWidth - doc.documentElement.clientWidth
			};
		})()`), 'Arabic Events Dashboard translation');
		assert.strictEqual(dashboard.language, 'ar');
		assert.strictEqual(dashboard.direction, 'rtl');
		assert.ok(dashboard.title && !/Events Dashboard/i.test(dashboard.title), 'Arabic dashboard title remained English');
		assert.ok(dashboard.headers.every(header => header === dashboard.title), 'Dashboard title and headers are inconsistent');
		assert.ok(dashboard.horizontalOverflow <= 20, `Arabic dashboard overflowed horizontally by ${dashboard.horizontalOverflow}px`);
		await captureScreenshot('events-ar');

		console.log(`PASS real Electron translation layout for ${locales.length} locales`);
	} catch (error) {
		console.error(error && error.stack ? error.stack : error);
		console.error('Recent SSApp stdout:\n', stdout);
		console.error('Recent SSApp stderr:\n', stderr);
		process.exitCode = 1;
	} finally {
		try {
			await request('/api/v1/command', { action: 'shutdownApp', value: { confirm: true } });
		} catch (_) { }
		await Promise.race([
			new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)),
			delay(5000)
		]);
		if (child.exitCode === null) child.kill();
		await mcp.close();
		for (let attempt = 0; attempt < 10; attempt += 1) {
			try {
				fs.rmSync(profileDirectory, { recursive: true, force: true });
				break;
			} catch (_) {
				await delay(250);
			}
		}
	}
}

run();
