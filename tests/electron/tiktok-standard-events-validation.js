'use strict';

// Optional companion to the running capture soak. Attaches only to its isolated
// profile and adds separately named fixture rows; it does not change settings.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const { waitFor } = require('./tiktok-disconnect-validation-e2e');

async function run() {
	const profileArg = process.argv.find(arg => arg.startsWith('--profile='));
	const relayArg = process.argv.find(arg => arg.startsWith('--relay-port='));
	assert.ok(profileArg && relayArg, 'Pass the active soak profile and relay port');
	const profile = path.resolve(profileArg.slice(10));
	assert.strictEqual(path.dirname(profile), path.resolve(os.tmpdir()));
	assert.ok(path.basename(profile).startsWith('ssapp-tiktok-soak-'));
	const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
	const relayPort = Number(relayArg.slice(13));
	assert.ok(Number.isInteger(port) && Number.isInteger(relayPort));
	const settings = JSON.parse(fs.readFileSync(path.join(profile, 'savedSync.json'), 'utf8'));
	assert.ok(settings.settings.capturelikeevent.setting);
	const prefix = `standard-event-probe-${Date.now()}`;
	const received = [];
	let browser, relay;
	try {
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
		relay = new WebSocket(`ws://127.0.0.1:${relayPort}`);
		await new Promise((resolve, reject) => { relay.once('open', resolve); relay.once('error', reject); });
		relay.on('message', raw => {
			try {
				const message = JSON.parse(raw.toString());
				if (message.type === 'tiktok' && String(message.chatname).includes(prefix)) received.push(message);
			} catch (_) { }
		});
		relay.send(JSON.stringify({ join: settings.streamID, out: 3, in: 4 }));
		await new Promise(resolve => setTimeout(resolve, 500));
		for (const variant of ['baseline', 'patched']) {
			const page = browser.contexts().flatMap(context => context.pages()).find(page => {
				try {
					const url = new URL(page.url());
					return url.hostname === '127.0.0.1' && url.pathname === `/@soak_${variant}/live`;
				} catch (_) { return false; }
			});
			assert.ok(page, 'Expected soak fixture source window');
			await page.evaluate(({ prefix, variant }) => {
				const feed = document.getElementById('tiktok-feed');
				for (let sequence = 0; sequence < 10; sequence++) {
					for (const kind of ['like', 'follow', 'chat']) {
						const wrapper = document.createElement('div');
						if (kind !== 'chat') wrapper.dataset.e2e = kind + '-message';
						const row = document.createElement('div');
						row.dataset.e2e = 'chat-message';
						row.dataset.index = `${prefix}-${kind}-${sequence}`;
						const avatar = document.createElement('div');
						const body = document.createElement('div');
						const author = document.createElement('span');
						author.dataset.e2e = 'message-owner-name';
						author.textContent = `${prefix}-${variant}-${kind}-${sequence}`;
						const text = document.createElement('span');
						text.className = 'break-words align-middle';
						text.textContent = kind === 'chat' ? 'I like this stream' : kind === 'like' ? 'liked the LIVE' : 'followed the host';
						body.append(author, text);
						row.append(avatar, body);
						wrapper.appendChild(row);
						feed.appendChild(wrapper);
					}
				}
			}, { prefix, variant });
		}
		await waitFor(() => received.length >= 60, 'all rendered Standard events at local relay', 15000);
		await new Promise(resolve => setTimeout(resolve, 1500));
		const counts = {};
		for (const variant of ['baseline', 'patched']) {
			counts[variant] = {};
			for (const kind of ['like', 'follow', 'chat']) {
				const messages = received.filter(message => message.chatname.includes(`${prefix}-${variant}-${kind}-`));
				assert.strictEqual(messages.length, 10);
				assert.strictEqual(new Set(messages.map(message => message.chatname)).size, 10);
				for (const message of messages) {
					if (kind === 'like') assert.strictEqual(message.event, 'liked');
					else if (kind === 'follow') assert.strictEqual(message.event, 'followed');
					else assert.ok(!message.event, 'Ordinary comment containing like must stay chat');
				}
				counts[variant][kind] = messages.length;
			}
		}
		const artifact = path.resolve(__dirname, '../../test-results', prefix + '.json');
		fs.writeFileSync(artifact, JSON.stringify({ outcome: 'PASS', scope: 'Rendered local fixture rows, like capture enabled; no live TikTok completeness claim', counts, received }, null, 2));
		console.log(JSON.stringify({ outcome: 'PASS', counts, artifact }));
	} finally {
		if (relay) relay.terminate();
		// Closing a connectOverCDP handle disconnects this client, not SSApp.
		if (browser) await browser.close();
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
