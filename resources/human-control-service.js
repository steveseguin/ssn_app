'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HUMAN_COMMANDS = {
	getHumanControlStatus: {
		name: 'ssapp_get_human_control_status', title: 'Human control status', readOnly: true,
		description: 'Read whether automation is paused for private human input. Does not reveal the page, viewer credentials, or private input. The viewer endpoint is local to the SSApp host; a remote bridge must transport it separately.',
		schema: { type: 'object', properties: {}, additionalProperties: false },
	},
};
const HUMAN_CONTROL_CAPABILITY = {
	version: '1.0.0', minimumSsappVersion: '0.4.40',
	viewer: '/api/v1/human/viewer', status: '/api/v1/human/status',
	start: '/api/v1/human/start', command: '/api/v1/human/command',
	finish: '/api/v1/human/finish', suspend: '/api/v1/human/suspend',
	frames: '/api/v1/human/frames/{targetId}',
	credentialHeader: 'X-SSApp-Human-Token', instanceHeader: 'X-SSApp-Instance-Id',
	privateInput: true, audio: false, maximumFps: 5,
	idleTimeoutMs: 120000, maximumSessionMs: 1800000,
};
const ALLOWED_COMMANDS = new Set([
	'listBrowserTargets', 'captureBrowserScreenshot', 'browserInput', 'navigateBrowserTarget',
	'getPendingAppDialogs', 'respondToAppDialog',
]);
const ASSETS = {
	'/api/v1/human/viewer': ['human-control.html', 'text/html; charset=utf-8'],
	'/api/v1/human/viewer.js': ['human-control.js', 'application/javascript; charset=utf-8'],
	'/api/v1/human/viewer.css': ['human-control.css', 'text/css; charset=utf-8'],
};

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// This is a privacy handoff inside the existing loopback trust boundary, not
// remote authentication. A bridge must authorize its human independently of an AI.
class HumanControlService {
	constructor(options) {
		this.options = options;
		this.session = null;
		this.pending = 0;
		this.timer = null;
	}

	get paused() { return this.session !== null; }

	status() {
		return { state: this.session?.state || 'idle', automationPaused: this.paused, viewer: HUMAN_CONTROL_CAPABILITY.viewer };
	}

	clearTimer() { clearTimeout(this.timer); this.timer = null; }

	suspend() {
		if (!this.session) return;
		this.clearTimer();
		this.session.token = null;
		this.session.state = 'suspended';
		this.options.stopStreams();
	}

	touch(session) {
		this.clearTimer();
		session.expiresAt = Math.min(Date.now() + HUMAN_CONTROL_CAPABILITY.idleTimeoutMs, session.deadline);
		this.timer = setTimeout(() => this.suspend(), Math.max(1, session.expiresAt - Date.now()));
		this.timer.unref();
	}

	authorize(req) {
		const session = this.session;
		const supplied = Buffer.from(String(req.headers['x-ssapp-human-token'] || ''));
		const expected = Buffer.from(session?.token || '');
		if (!session || session.state !== 'active' || !expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
			fail('HUMAN_CONTROL_UNAUTHORIZED', 'Open a new authorized human viewer session.');
		}
		if (Date.now() >= session.expiresAt) { this.suspend(); fail('HUMAN_CONTROL_EXPIRED', 'Human viewing expired. Automation remains paused.'); }
		this.touch(session);
		return session;
	}

	start(value) {
		if (value.confirm !== true) fail('CONFIRMATION_REQUIRED', 'Human takeover requires confirm: true.');
		if (!this.options.available()) fail('SSAPP_UNAVAILABLE', 'Enable Local AI / Automation and restart SSApp.');
		if (this.session?.state === 'active') fail('HUMAN_CONTROL_BUSY', 'A human viewer already has control.');
		if (!this.session) {
			this.session = { state: 'waiting', token: null };
			this.options.pause();
		}
		if (this.options.automationPending() || this.pending) fail('HUMAN_CONTROL_DRAINING', 'Automation is paused. Wait for earlier operations to finish, then retry takeover.');
		this.options.stopStreams();
		const session = { state: 'active', token: crypto.randomBytes(32).toString('base64url'), deadline: Date.now() + HUMAN_CONTROL_CAPABILITY.maximumSessionMs };
		this.session = session;
		this.touch(session);
		return { ...this.status(), token: session.token, expiresAt: session.expiresAt, deadline: session.deadline };
	}

	async handle(req, res, url, sendJson, readBody) {
		if (!url.pathname.startsWith('/api/v1/human/')) return false;
		try {
			const asset = ASSETS[url.pathname];
			if (asset && req.method === 'GET') {
				res.writeHead(200, {
					'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
					'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
					'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
				});
				res.end(await fs.promises.readFile(path.join(__dirname, asset[0])));
				return true;
			}
			if (url.pathname === HUMAN_CONTROL_CAPABILITY.status && req.method === 'GET') {
				sendJson(200, { ok: true, payload: this.status() });
				return true;
			}
			// All private requests are tied to one running SSApp, including session creation.
			if (req.headers['x-ssapp-instance-id'] !== this.options.instanceId) fail('SSAPP_INSTANCE_REQUIRED', 'Discover /api/v1/instance and send X-SSApp-Instance-Id.');
			if (url.pathname === HUMAN_CONTROL_CAPABILITY.start && req.method === 'POST') {
				const value = JSON.parse(await readBody(req, 4096));
				sendJson(200, { ok: true, payload: this.start(value || {}) });
				return true;
			}
			const session = this.authorize(req);
			const frames = /^\/api\/v1\/human\/frames\/(wc%3A\d+|wc:\d+)$/i.exec(url.pathname);
			if (frames && req.method === 'GET') {
				this.options.prepareTarget(decodeURIComponent(frames[1]));
				await this.options.stream(req, res, { ...url, pathname: `/api/v1/browser/frames/${frames[1]}` });
				return true;
			}
			if (req.method !== 'POST') fail('METHOD_NOT_ALLOWED', 'Unsupported human-control method.');
			const value = JSON.parse(await readBody(req, 128 * 1024));
			// The lease may expire while a request body is arriving.
			if (this.authorize(req) !== session) fail('HUMAN_CONTROL_UNAUTHORIZED', 'Viewer session changed.');
			if (url.pathname === HUMAN_CONTROL_CAPABILITY.finish || url.pathname === HUMAN_CONTROL_CAPABILITY.suspend) {
				if (value?.confirm !== true) fail('CONFIRMATION_REQUIRED', 'Ending human control requires confirm: true.');
				if (url.pathname === HUMAN_CONTROL_CAPABILITY.suspend) this.suspend();
				else {
					if (this.pending) fail('HUMAN_CONTROL_BUSY', 'Wait for the current viewer operation to finish.');
					this.clearTimer();
					this.options.stopStreams();
					this.session = null;
					this.options.resume();
				}
				sendJson(200, { ok: true, payload: this.status() });
				return true;
			}
			if (url.pathname !== HUMAN_CONTROL_CAPABILITY.command) fail('METHOD_NOT_ALLOWED', 'Unsupported human-control path.');
			if (!ALLOWED_COMMANDS.has(value?.action)) fail('HUMAN_COMMAND_NOT_ALLOWED', 'This action is unavailable in the private viewer.');
			if (value.action === 'respondToAppDialog' && value.value?.paths !== undefined) fail('HUMAN_COMMAND_NOT_ALLOWED', 'Host-file selection requires the separate authorized file workflow.');
			if (this.pending >= 4) fail('HUMAN_CONTROL_BUSY', 'Wait for earlier viewer requests.');
			if (value.action === 'captureBrowserScreenshot') this.options.prepareTarget(value.value?.targetId);
			this.pending++;
			try {
				const guard = () => {
					if (this.session !== session || session.state !== 'active' || Date.now() >= session.expiresAt) fail('HUMAN_CONTROL_EXPIRED', 'Viewer disconnected or expired. Automation remains paused.');
				};
				const result = await this.options.executeCommand(value, guard);
				guard();
				sendJson(result?.ok ? 200 : 400, result);
			} finally { this.pending--; }
		} catch (error) {
			if (res.headersSent) res.destroy();
			else sendJson(error.code === 'HUMAN_CONTROL_UNAUTHORIZED' ? 403 : 409, {
				ok: false, error: { code: error.code || 'INVALID_REQUEST', message: error.code ? error.message : 'Invalid human-control request.' },
			});
		}
		return true;
	}

	close() { this.clearTimer(); this.options.stopStreams(); this.session = null; }
}

module.exports = { HumanControlService, HUMAN_COMMANDS, HUMAN_CONTROL_CAPABILITY };
