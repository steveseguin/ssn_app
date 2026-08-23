#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const sharp = require('sharp');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const electronPath = require('electron');
const appRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(appRoot, '..', 'social_stream');

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
		await Promise.race([
			new Promise(resolve => child.once('exit', resolve)),
			delay(2000)
		]);
		if (child.exitCode === null) child.kill();
	};
	return { request, call, close };
}

function payloadOf(toolResult) {
	const result = toolResult?.structuredContent?.result || toolResult?.structuredContent || {};
	return result.payload || result.result?.payload || {};
}

function delay(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function decodeScreenshot(buffer) {
	const { data, info } = await sharp(buffer)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels };
}

function screenshotPixel(image, point, viewport) {
	const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x * image.width / viewport.width)));
	const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y * image.height / viewport.height)));
	const offset = ((y * image.width) + x) * image.channels;
	return Array.from(image.data.subarray(offset, offset + 3));
}

function maximumColorDifference(first, second) {
	return Math.max(...first.map((channel, index) => Math.abs(channel - second[index])));
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

async function run() {
	const controlPort = await getFreePort();
	const token = `rumble-chrome-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-rumble-chrome-ui-'));
	const sourceUrl = pathToFileURL(`${socialStreamRoot}${path.sep}`).href;
	const screenshotDirectory = process.env.SSAPP_A11Y_SCREENSHOT_DIR || '';
	const screenshotPrefix = process.env.SSAPP_A11Y_SCREENSHOT_PREFIX || 'signin-choice';
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

		await mcp.request('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'ssapp-signin-choice-a11y-e2e', version: '1.0.0' }
		});
		const windows = payloadOf(await mcp.call('ssapp_list_app_windows')).windows || [];
		const appWindow = windows.find(windowInfo => windowInfo.kind === 'main');
		assert.ok(appWindow?.windowId, 'MCP did not report the main SSApp window');
		const execute = async code => (await request('/exec', { windowId: mainWindow.id, code })).result;
		const inspectApp = async () => payloadOf(await mcp.call('ssapp_inspect_app_window', {
			windowId: appWindow.windowId,
			maxElements: 200,
			maxTextChars: 20000,
			elementOrder: 'reverse'
		}));
		const pressKey = async (ref, key) => mcp.call('ssapp_interact_app_window', {
			windowId: appWindow.windowId,
			ref,
			action: 'pressKey',
			key,
			confirm: true
		});
		const captureScreenshot = async suffix => {
			if (screenshotDirectory) fs.mkdirSync(screenshotDirectory, { recursive: true });
			let screenshot;
			let lastError;
			for (let attempt = 0; attempt < 5; attempt += 1) {
				try {
					screenshot = await mcp.call('ssapp_capture_app_window_screenshot', {
						windowId: appWindow.windowId,
						format: 'png',
						maxWidth: 1200
					});
					break;
				} catch (error) {
					lastError = error;
					await delay(250);
				}
			}
			if (!screenshot) throw lastError || new Error('MCP screenshot failed');
			const image = (screenshot.content || []).find(item => item.type === 'image' && item.mimeType === 'image/png');
			assert.ok(image?.data, 'MCP did not return a PNG screenshot');
			const buffer = Buffer.from(image.data, 'base64');
			if (screenshotDirectory) {
				const screenshotPath = path.join(screenshotDirectory, `${screenshotPrefix}-${suffix}.png`);
				fs.writeFileSync(screenshotPath, buffer);
				console.log(`Saved SSApp theme screenshot: ${screenshotPath}`);
			}
			return buffer;
		};
		const saveScreenshot = captureScreenshot;
		const assertWelcomeFrameTransparency = async theme => {
			await execute(theme === 'light'
				? `document.documentElement.dataset.ssappTheme = 'light'; true`
				: `delete document.documentElement.dataset.ssappTheme; true`);
			const state = await waitFor(async () => await execute(`(() => {
				const frame = document.getElementById('welcomeFrame');
				const frameDocument = frame?.contentDocument;
				if (!frame || !frameDocument?.body) return null;
				const rect = frame.getBoundingClientRect();
				const container = frameDocument.querySelector('.container');
				const containerRect = container?.getBoundingClientRect();
				if (rect.width < 100 || rect.height < 100 || !containerRect) return null;
				return {
					viewport: { width: innerWidth, height: innerHeight },
					frameRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
					containerRect: { left: containerRect.left, top: containerRect.top, right: containerRect.right, bottom: containerRect.bottom },
					containerText: container.textContent || '',
					rootColorScheme: getComputedStyle(document.documentElement).colorScheme,
					frameColorScheme: getComputedStyle(frame).colorScheme,
					guideHtmlBackground: getComputedStyle(frameDocument.documentElement).background,
					guideBodyBackground: getComputedStyle(frameDocument.body).background,
					guideHtmlBackgroundImage: getComputedStyle(frameDocument.documentElement).backgroundImage,
					guideBodyBackgroundImage: getComputedStyle(frameDocument.body).backgroundImage
				};
			})()`), `welcome frame in ${theme} theme`);
			assert.strictEqual(state.rootColorScheme, 'normal', `${theme} theme leaked its native color scheme into embedded pages`);
			assert.strictEqual(state.frameColorScheme, 'normal', `${theme} theme leaked its native color scheme into the welcome iframe`);
			assert.match(state.containerText, /Welcome to Social Stream Ninja/, `${theme} guide content did not load`);
			assert.strictEqual(state.guideHtmlBackgroundImage, 'none', `${theme} guide html retained a background image`);
			assert.strictEqual(state.guideBodyBackgroundImage, 'none', `${theme} guide body retained a background image`);

			const visible = await captureScreenshot(`welcome-${theme}`);
			await execute(`document.getElementById('welcomeFrame').style.visibility = 'hidden'; true`);
			let hidden;
			try {
				await delay(100);
				hidden = await captureScreenshot(`welcome-${theme}-frame-hidden`);
			} finally {
				await execute(`document.getElementById('welcomeFrame').style.visibility = ''; true`);
			}
			const [visibleImage, hiddenImage] = await Promise.all([
				decodeScreenshot(visible),
				decodeScreenshot(hidden)
			]);
			const samplePoints = [
				{ x: state.frameRect.left + 8, y: state.frameRect.top + 8 },
				{ x: state.frameRect.left + 18, y: state.frameRect.top + 8 },
				{ x: state.frameRect.right - 18, y: state.frameRect.top + 8 }
			];
			const differences = samplePoints.map(point => maximumColorDifference(
				screenshotPixel(visibleImage, point, state.viewport),
				screenshotPixel(hiddenImage, point, state.viewport)
			));
			const maximumDifference = Math.max(...differences);
			assert.ok(maximumDifference <= 2, `${theme} welcome iframe painted an opaque canvas (pixel difference ${maximumDifference})`);
			const contentPoint = {
				x: state.frameRect.left + state.containerRect.left + 10,
				y: state.frameRect.top + state.containerRect.top + 10
			};
			const contentDifference = maximumColorDifference(
				screenshotPixel(visibleImage, contentPoint, state.viewport),
				screenshotPixel(hiddenImage, contentPoint, state.viewport)
			);
			assert.ok(contentDifference >= 5, `${theme} welcome guide content was not visibly painted`);
			return { maximumDifference, contentDifference, rootColorScheme: state.rootColorScheme };
		};

		const welcomeThemeResults = {
			dark: await assertWelcomeFrameTransparency('dark'),
			light: await assertWelcomeFrameTransparency('light')
		};
		await execute(`delete document.documentElement.dataset.ssappTheme; true`);

		const preview = await execute(`(async () => {
			if (!window.stateManager || typeof createSourceElement !== 'function') return false;
			const sourceId = stateManager.addSource({
				id: 'rumble-signin-choice-preview',
				target: 'rumble',
				url: 'https://rumble.com/login',
				customSession: 'Accessibility preview',
				connectionMode: 'classic'
			});
			let element = document.querySelector('[data-source-id="' + sourceId + '"]');
			if (!element) {
				element = createSourceElement(sourceId);
				if (element) document.getElementById('sources').appendChild(element);
			}
			if (!element) return false;
			const signinButton = element.querySelector('[data-signin]');
			signinButton.focus();
			return showSigninMethodChoice(signinButton, stateManager.getSource(sourceId));
		})()`);
		assert.strictEqual(preview, true, 'could not open sign-in chooser for visual review');
		await delay(150);

		const getAccessibilityState = () => execute(`(() => {
			const parseRgb = value => (String(value).match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
			const luminance = value => {
				const rgb = parseRgb(value).map(channel => {
					const normalized = channel / 255;
					return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
				});
				return (0.2126 * rgb[0]) + (0.7152 * rgb[1]) + (0.0722 * rgb[2]);
			};
			const contrast = (foregroundElement, backgroundElement = foregroundElement) => {
				const foreground = luminance(getComputedStyle(foregroundElement).color);
				const background = luminance(getComputedStyle(backgroundElement).backgroundColor);
				return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
			};
			const modal = document.getElementById('tiktok-auth-modal');
			const dialog = modal?.querySelector('[role="dialog"]');
			const chrome = modal?.querySelector('[data-signin-choice="chrome"]');
			const ssapp = modal?.querySelector('[data-signin-choice="ssapp"]');
			const cancel = modal?.querySelector('[data-signin-choice="cancel"]');
			const chromeDescription = chrome?.querySelector('.signin-method-option-description');
			const ssappDescription = ssapp?.querySelector('.signin-method-option-description');
			const rect = dialog?.getBoundingClientRect();
			const colors = element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor });
			const focusedStyle = document.activeElement ? getComputedStyle(document.activeElement) : null;
			return {
				dialogCount: modal?.querySelectorAll('[role="dialog"]').length || 0,
				labelledBy: dialog?.getAttribute('aria-labelledby') || '',
				describedBy: dialog?.getAttribute('aria-describedby') || '',
				focusedChoice: document.activeElement?.dataset?.signinChoice || '',
				backgroundInert: Array.from(document.body.children).filter(element => element !== modal && !['SCRIPT', 'STYLE'].includes(element.tagName)).every(element => element.inert),
				contrast: { chrome: contrast(chrome), ssapp: contrast(ssapp), cancel: contrast(cancel) },
				descriptionContrast: {
					chrome: contrast(chromeDescription, chrome),
					ssapp: contrast(ssappDescription, ssapp)
				},
				colors: { chrome: colors(chrome), ssapp: colors(ssapp), cancel: colors(cancel) },
				descriptionColors: { chrome: colors(chromeDescription), ssapp: colors(ssappDescription) },
				descriptionParentColors: { chrome: colors(chromeDescription.parentElement), ssapp: colors(ssappDescription.parentElement) },
				focusAppearance: {
					classApplied: document.activeElement?.classList?.contains('ssapp-visible-focus') || false,
					outlineStyle: focusedStyle?.outlineStyle || '',
					outlineWidth: parseFloat(focusedStyle?.outlineWidth || '0'),
					outlineColor: focusedStyle?.outlineColor || '',
					boxShadow: focusedStyle?.boxShadow || ''
				},
				fitsViewport: !!rect && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
				horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
				colorScheme: getComputedStyle(dialog).colorScheme
			};
		})()`);

		await saveScreenshot('dark');
		const darkState = await getAccessibilityState();
		assert.strictEqual(darkState.dialogCount, 1, 'chooser should expose one dialog landmark');
		assert.strictEqual(darkState.labelledBy, 'signin-method-title');
		assert.match(darkState.describedBy, /signin-method-context/);
		assert.match(darkState.describedBy, /signin-method-note/);
		assert.strictEqual(darkState.focusedChoice, 'chrome', 'initial focus should enter the chooser');
		assert.strictEqual(darkState.backgroundInert, true, 'the app behind the chooser should be inert');
		assert.strictEqual(darkState.colorScheme, 'dark', 'dark chooser should use dark native controls');
		assert.ok(darkState.contrast.chrome >= 4.5, `Chrome option contrast was ${darkState.contrast.chrome}`);
		assert.ok(darkState.contrast.ssapp >= 4.5, `SSApp option contrast was ${darkState.contrast.ssapp}`);
		assert.ok(darkState.contrast.cancel >= 4.5, `Cancel contrast was ${darkState.contrast.cancel}`);
		assert.ok(darkState.descriptionContrast.chrome >= 4.5, `Chrome description contrast was ${darkState.descriptionContrast.chrome}`);
		assert.ok(darkState.descriptionContrast.ssapp >= 4.5, `SSApp description contrast was ${darkState.descriptionContrast.ssapp}`);
		assert.strictEqual(darkState.fitsViewport, true, 'chooser should fit the app viewport');
		assert.strictEqual(darkState.horizontalOverflow, false, 'chooser should not create horizontal scrolling');

		let inspection = await inspectApp();
		let option = inspection.elements.find(element => (element.name || '').includes('Use Chrome'));
		assert.ok(option?.ref, `MCP could not identify the Chrome sign-in option: ${JSON.stringify(inspection.elements.slice(0, 20))}`);
		await pressKey(option.ref, 'Tab');
		await delay(75);
		assert.strictEqual(await execute(`document.activeElement?.dataset?.signinChoice || ''`), 'ssapp', 'Tab should move to the SSApp option');
		await saveScreenshot('dark-keyboard-focus');
		const focusedDarkState = await getAccessibilityState();
		assert.strictEqual(focusedDarkState.focusAppearance.classApplied, true, 'focused chooser action should have the persistent visible-focus class');
		assert.notStrictEqual(focusedDarkState.focusAppearance.outlineStyle, 'none', 'focused chooser action should paint an outline');
		assert.ok(focusedDarkState.focusAppearance.outlineWidth >= 2, `focused chooser outline was ${focusedDarkState.focusAppearance.outlineWidth}px`);
		assert.notStrictEqual(focusedDarkState.focusAppearance.boxShadow, 'none', 'focused chooser action should paint an inset focus ring');

		await execute(`document.documentElement.dataset.ssappTheme = 'light'; true`);
		await delay(250);
		await saveScreenshot('light');
		const lightState = await getAccessibilityState();
		assert.strictEqual(lightState.colorScheme, 'light', 'light chooser should use light native controls');
		assert.ok(lightState.contrast.chrome >= 4.5, `Light Chrome option contrast was ${lightState.contrast.chrome}`);
		assert.ok(lightState.contrast.ssapp >= 4.5, `Light SSApp option contrast was ${lightState.contrast.ssapp}: ${JSON.stringify(lightState.colors.ssapp)}`);
		assert.ok(lightState.contrast.cancel >= 4.5, `Light Cancel contrast was ${lightState.contrast.cancel}: ${JSON.stringify(lightState.colors.cancel)}`);
		assert.ok(lightState.descriptionContrast.chrome >= 4.5, `Light Chrome description contrast was ${lightState.descriptionContrast.chrome}`);
		assert.ok(lightState.descriptionContrast.ssapp >= 4.5, `Light SSApp description contrast was ${lightState.descriptionContrast.ssapp}: ${JSON.stringify(lightState.descriptionColors.ssapp)} parent ${JSON.stringify(lightState.descriptionParentColors.ssapp)} on ${JSON.stringify(lightState.colors.ssapp)}`);
		await execute(`delete document.documentElement.dataset.ssappTheme; true`);
		await execute(`window.resizeTo(480, 640); true`);
		await delay(150);
		await saveScreenshot('dark-narrow');
		const narrowState = await getAccessibilityState();
		assert.strictEqual(narrowState.fitsViewport, true, 'chooser should fit a narrow app window');
		assert.strictEqual(narrowState.horizontalOverflow, false, 'narrow chooser should not create horizontal scrolling');
		await execute(`window.resizeTo(1200, 720); true`);
		await delay(150);

		inspection = await inspectApp();
		option = inspection.elements.find(element => (element.name || '').includes('Use the SSApp sign-in window'));
		assert.ok(option?.ref, 'MCP could not identify the SSApp sign-in option');
		await pressKey(option.ref, 'Tab');
		await delay(75);
		assert.strictEqual(await execute(`document.activeElement?.dataset?.signinChoice || ''`), 'cancel', 'Tab should move to Cancel');
		inspection = await inspectApp();
		option = inspection.elements.find(element => element.name === 'Cancel');
		assert.ok(option?.ref, 'MCP could not identify Cancel');
		await pressKey(option.ref, 'Tab');
		await delay(75);
		assert.strictEqual(await execute(`document.activeElement?.dataset?.signinChoice || ''`), 'chrome', 'Tab should wrap within the chooser');
		assert.strictEqual(await execute(`(() => {
			const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
			document.activeElement.dispatchEvent(event);
			return document.activeElement?.dataset?.signinChoice || '';
		})()`), 'cancel', 'Shift+Tab should wrap backward within the chooser');
		inspection = await inspectApp();
		option = inspection.elements.find(element => element.name === 'Cancel');
		await pressKey(option.ref, 'Tab');
		await delay(75);
		inspection = await inspectApp();
		option = inspection.elements.find(element => (element.name || '').includes('Use Chrome'));
		await pressKey(option.ref, 'Escape');
		await delay(75);
		const restoredFocus = await execute(`({
			modalClosed: !document.getElementById('tiktok-auth-modal'),
			focusRestored: document.activeElement === document.querySelector('[data-source-id="rumble-signin-choice-preview"] [data-signin]'),
			backgroundRestored: Array.from(document.body.children).filter(element => !['SCRIPT', 'STYLE'].includes(element.tagName)).every(element => !element.inert)
		})`);
		assert.strictEqual(restoredFocus.modalClosed, true, 'Escape should close the chooser');
		assert.strictEqual(restoredFocus.focusRestored, true, 'Escape should restore focus to Sign-in');
		assert.strictEqual(restoredFocus.backgroundRestored, true, 'closing should restore the app background');

		inspection = await inspectApp();
		const settingsTrigger = inspection.elements.find(element => element.name === 'Additional settings for Rumble');
		assert.ok(settingsTrigger?.ref, 'MCP could not identify the source settings disclosure');
		await mcp.call('ssapp_interact_app_window', {
			windowId: appWindow.windowId,
			ref: settingsTrigger.ref,
			action: 'click',
			confirm: true
		});
		await delay(100);
		await saveScreenshot('settings-keyboard-focus');
		const settingsState = await execute(`(() => {
			const entry = document.querySelector('[data-source-id="rumble-signin-choice-preview"]');
			const trigger = entry.querySelector('.settings-btn');
			const menu = entry.querySelector('.settings-menu');
			const chromeItem = menu.querySelector('[data-signin-chrome]');
			const focusedStyle = getComputedStyle(document.activeElement);
			return {
				triggerTag: trigger.tagName,
				expanded: trigger.getAttribute('aria-expanded'),
				controlsMatch: trigger.getAttribute('aria-controls') === menu.id,
				firstItemFocused: document.activeElement === menu.querySelector('.settings-menu-item:not(.hidden)'),
				chromeRole: chromeItem.getAttribute('role'),
				chromeTabIndex: chromeItem.tabIndex,
				focusClassApplied: document.activeElement.classList.contains('ssapp-visible-focus'),
				focusOutlineWidth: parseFloat(focusedStyle.outlineWidth || '0')
			};
		})()`);
		assert.strictEqual(settingsState.triggerTag, 'BUTTON', 'settings disclosure should use a native keyboard-operable button');
		assert.strictEqual(settingsState.expanded, 'true');
		assert.strictEqual(settingsState.controlsMatch, true);
		assert.strictEqual(settingsState.firstItemFocused, true, 'opening settings should focus its first action');
		assert.strictEqual(settingsState.chromeRole, 'button');
		assert.strictEqual(settingsState.chromeTabIndex, 0);
		assert.strictEqual(settingsState.focusClassApplied, true, 'focused settings action should show the shared focus treatment');
		assert.ok(settingsState.focusOutlineWidth >= 2, `settings focus outline was ${settingsState.focusOutlineWidth}px`);
		inspection = await inspectApp();
		const firstMenuItem = inspection.elements.find(element => element.name === '🧹 Clear cache & storage');
		assert.ok(firstMenuItem?.ref, 'MCP could not identify a keyboard-accessible settings action');
		await pressKey(firstMenuItem.ref, 'Escape');
		await delay(75);
		const closedSettingsState = await execute(`(() => {
			const entry = document.querySelector('[data-source-id="rumble-signin-choice-preview"]');
			return {
				expanded: entry.querySelector('.settings-btn').getAttribute('aria-expanded'),
				focusRestored: document.activeElement === entry.querySelector('.settings-btn')
			};
		})()`);
		assert.strictEqual(closedSettingsState.expanded, 'false');
		assert.strictEqual(closedSettingsState.focusRestored, true, 'Escape should restore focus to the settings trigger');

		const result = await waitFor(async () => {
			const response = await request('/exec', {
				windowId: mainWindow.id,
				code: `(async () => {
					if (!window.stateManager || typeof createSourceElement !== 'function') return null;
					const otherSigninTargets = [
						'arenasocial', 'beamstream', 'bitchute', 'blaze', 'chatgpt', 'discord',
						'facebook', 'favorited', 'instagram', 'instagramlive', 'joystick', 'kick',
						'linkedin', 'locals', 'loco', 'mixcloud', 'parti', 'patreon', 'restream',
						'telegram', 'telegramk', 'twitch', 'webex', 'x', 'youtube',
						'youtubeshorts', 'zoom'
					];
					const rumbleId = stateManager.addSource({
						id: 'rumble-chrome-ui-e2e',
						target: 'rumble',
						url: 'https://rumble.com/login',
						customSession: 'chrome-trial-profile',
						connectionMode: 'classic'
					});
					const tiktokId = stateManager.addSource({
						id: 'tiktok-chrome-ui-e2e',
						target: 'tiktok',
						url: 'https://www.tiktok.com/login',
						customSession: 'tiktok-trial-profile',
						connectionMode: 'classic'
					});
					const otherSigninIds = otherSigninTargets.map(target => stateManager.addSource({
						id: target + '-chrome-ui-e2e',
						target,
						url: 'https://example.invalid/',
						customSession: 'chrome-trial-profile',
						connectionMode: 'classic'
					}));
					const secondRumbleId = stateManager.addSource({
						id: 'rumble-chrome-ui-e2e-second',
						target: 'rumble',
						url: 'https://rumble.com/login',
						customSession: 'second-rumble-profile',
						connectionMode: 'classic'
					});
					await Promise.resolve();
					const sources = document.getElementById('sources');
					function ensureElement(sourceId) {
						let element = document.querySelector('[data-source-id="' + sourceId + '"]');
						if (!element) {
							element = createSourceElement(sourceId);
							if (element) sources.appendChild(element);
						}
						return element;
					}
					const rumbleElement = ensureElement(rumbleId);
					const tiktokElement = ensureElement(tiktokId);
					const otherSigninElements = otherSigninIds.map(ensureElement);
					const unsupportedElement = otherSigninElements[otherSigninTargets.indexOf('mixcloud')];
					const secondRumbleElement = ensureElement(secondRumbleId);
					if (!rumbleElement || !tiktokElement || !unsupportedElement || otherSigninElements.some(element => !element) || !secondRumbleElement) return null;
					const chromeMenuItem = rumbleElement.querySelector('[data-signin-chrome]');
					const standardButton = rumbleElement.querySelector('[data-signin]');
					const tiktokChromeMenuItem = tiktokElement.querySelector('[data-signin-chrome]');
					const tiktokStandardButton = tiktokElement.querySelector('[data-signin]');
					const unsupportedStandardButton = unsupportedElement.querySelector('[data-signin]');
					const secondChromeMenuItem = secondRumbleElement.querySelector('[data-signin-chrome]');
					const initial = {
						chromeMenuVisible: !chromeMenuItem.classList.contains('hidden'),
						standardVisible: !standardButton.classList.contains('hidden'),
						tiktokChromeMenuVisible: !tiktokChromeMenuItem.classList.contains('hidden'),
						tiktokStandardVisible: !tiktokStandardButton.classList.contains('hidden'),
						mainChromeButtonCount: rumbleElement.querySelectorAll('.entry-actions-main [data-signin-chrome]').length,
						unexpectedChromeTargets: otherSigninElements
							.filter(element => !element.querySelector('[data-signin-chrome]').classList.contains('hidden'))
							.map(element => element.dataset.target),
						chromeAccessibleName: chromeMenuItem.getAttribute('aria-label'),
						tiktokChromeAccessibleName: tiktokChromeMenuItem.getAttribute('aria-label'),
						secondChromeAccessibleName: secondChromeMenuItem.getAttribute('aria-label')
					};

					const originalInvoke = ipcRenderer.invoke;
					const invocations = [];
					ipcRenderer.invoke = async (channel, payload) => {
						if (channel === 'external-browser-signin' || channel === 'signIn') {
							invocations.push({
								channel,
								platform: payload?.platform || null,
								sourceId: payload?.sourceId || null,
								customSession: payload?.customSession || null
							});
							if (channel === 'signIn') return 7001;
							return { success: false, cancelled: true };
						}
						return await originalInvoke.call(ipcRenderer, channel, payload);
					};
					try {
						await signin(standardButton);
						let chooser = document.getElementById('tiktok-auth-modal');
						const chooserOpened = !!chooser;
						const chooserText = chooser?.textContent || '';
						chooser?.querySelector('[data-signin-choice="ssapp"]')?.click();
						await new Promise(resolve => setTimeout(resolve, 0));

						await signin(standardButton);
						chooser = document.getElementById('tiktok-auth-modal');
						chooser?.querySelector('[data-signin-choice="chrome"]')?.click();
						await new Promise(resolve => setTimeout(resolve, 0));

						await signinViaChrome(tiktokChromeMenuItem);
						await signin(unsupportedStandardButton);
						await new Promise(resolve => setTimeout(resolve, 0));
						initial.chooserOpened = chooserOpened;
						initial.chooserText = chooserText;
						initial.unsupportedChooserOpened = !!document.getElementById('tiktok-auth-modal');
					} finally {
						ipcRenderer.invoke = originalInvoke;
					}

					const source = stateManager.getSource(rumbleId);
					source.connectionMode = 'websocket';
					updateSourceUI(rumbleElement, source);
					const hiddenInWebsocketMode = chromeMenuItem.classList.contains('hidden');
					source.connectionMode = 'classic';
					updateSourceUI(rumbleElement, source);
					const tiktokSource = stateManager.getSource(tiktokId);
					tiktokSource.connectionMode = 'tiktok-websocket';
					updateSourceUI(tiktokElement, tiktokSource);
					const tiktokHiddenInWebsocketMode = tiktokChromeMenuItem.classList.contains('hidden');
					return {
						...initial,
						hiddenInWebsocketMode,
						tiktokHiddenInWebsocketMode,
						visibleAfterRestore: !chromeMenuItem.classList.contains('hidden'),
						invocations
					};
				})()`
			});
			return response.result || false;
		}, 'Rumble Chrome sign-in UI');

		assert.strictEqual(result.chromeMenuVisible, true, 'the Chrome settings action should be visible for classic Rumble');
		assert.strictEqual(result.standardVisible, true, 'the existing in-app sign-in button must remain visible');
		assert.strictEqual(result.tiktokChromeMenuVisible, true, 'the Chrome settings action should be visible for classic TikTok');
		assert.strictEqual(result.tiktokStandardVisible, true, 'TikTok\'s existing in-app sign-in button must remain visible');
		assert.strictEqual(result.mainChromeButtonCount, 0, 'Chrome sign-in must not occupy a second main source button');
		assert.deepStrictEqual(result.unexpectedChromeTargets, [], 'the Chrome settings action must remain limited to its explicit platform allowlist');
		assert.strictEqual(result.chromeAccessibleName, 'Sign into Rumble via Chrome for chrome-trial-profile');
		assert.strictEqual(result.tiktokChromeAccessibleName, 'Sign into TikTok via Chrome for tiktok-trial-profile');
		assert.strictEqual(result.secondChromeAccessibleName, 'Sign into Rumble via Chrome for second-rumble-profile');
		assert.notStrictEqual(result.chromeAccessibleName, result.secondChromeAccessibleName, 'profile-specific Chrome sign-in buttons must be distinguishable to MCP and assistive technology');
		assert.strictEqual(result.chooserOpened, true, 'clicking Sign-in should offer both methods for an eligible classic source');
		assert.match(result.chooserText, /Use Chrome/);
		assert.match(result.chooserText, /Use the SSApp sign-in window/);
		assert.match(result.chooserText, /After signing in through the SSApp window, close that sign-in window/);
		assert.match(result.chooserText, /leave Chrome open until SSApp finishes importing/);
		assert.strictEqual(result.unsupportedChooserOpened, false, 'unsupported sources must keep their existing direct sign-in behavior');
		assert.strictEqual(result.hiddenInWebsocketMode, true, 'the Chrome settings action must hide in WebSocket mode');
		assert.strictEqual(result.tiktokHiddenInWebsocketMode, true, 'the Chrome settings action must hide for TikTok WebSocket modes');
		assert.strictEqual(result.visibleAfterRestore, true, 'the Chrome settings action should return in classic mode');
		assert.deepStrictEqual(result.invocations, [
			{
				channel: 'signIn',
				platform: 'rumble',
				sourceId: null,
				customSession: 'chrome-trial-profile'
			},
			{
				channel: 'external-browser-signin',
				platform: 'rumble',
				sourceId: 'rumble-chrome-ui-e2e',
				customSession: 'chrome-trial-profile'
			},
			{
				channel: 'external-browser-signin',
				platform: 'tiktok',
				sourceId: 'tiktok-chrome-ui-e2e',
				customSession: 'tiktok-trial-profile'
			},
			{
				channel: 'signIn',
				platform: 'mixcloud',
				sourceId: null,
				customSession: 'chrome-trial-profile'
			}
		]);
		console.log(`Rumble Chrome sign-in UI end-to-end checks passed. Welcome transparency: ${JSON.stringify(welcomeThemeResults)}`);
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
