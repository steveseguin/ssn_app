'use strict';

// Drives the app's --hidden-capture-diagnostics routine, which creates a real source
// window, hides it through the same path the hide button uses, and checks that the window
// really disappears and that capture keeps running while it is hidden.
//
// Point it at a live chat page to test the real thing:
//   node tests/electron/hidden-capture-diagnostics.js --url="https://www.youtube.com/live_chat?v=VIDEO_ID"
//
// Add --headless to run it the way a cloud or server install runs, where every window is
// forced hidden for the whole session:
//   node tests/electron/hidden-capture-diagnostics.js --headless --url="..."

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const electronPath = require('electron');

const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const reportPath = path.join(os.tmpdir(), `ssapp-hidden-capture-${Date.now()}.json`);
// Isolated profile: the diagnostics exit the app abruptly, which the app's own stability
// tracker counts as an unclean exit and eventually answers by escalating GPU fallback.
// Keep that out of the real profile.
//
// This has to be SSAPP_USER_DATA_DIR rather than Chromium's --user-data-dir. The app calls
// app.setPath('userData', ...) during startup, which overrides --user-data-dir for
// sessions, cookies and recovered settings, so that flag alone would leave the run reading
// and writing the real profile.
const userDataDir = path.join(os.tmpdir(), `ssapp-hidden-capture-profile-${Date.now()}`);

function parseUrlArg() {
	const arg = process.argv.find((value) => value.startsWith('--url='));
	if (arg) return arg.slice('--url='.length);
	const platformArg = process.argv.find((value) => value.startsWith('--platform='));
	if (!platformArg) return null;
	const platform = platformArg.slice('--platform='.length).trim().toLowerCase();
	if (!['youtube', 'twitch', 'kick', 'tiktok', 'worldswave'].includes(platform)) return null;
	const fixtureUrl = pathToFileURL(path.join(repoRoot, 'tests', 'electron', 'fixtures', 'hidden-capture.html')).href;
	return `${fixtureUrl}?platform=${encodeURIComponent(platform)}`;
}

function printReport(report) {
	if (!report || typeof report !== 'object') {
		console.error('[hidden-capture] No report data available.');
		return;
	}

	if (report.error) {
		console.error(`[hidden-capture] ERROR ${report.error}`);
		return;
	}

	console.log(
		`[hidden-capture] platform=${report.platform} electron=${report.electron} ` +
		`chrome=${report.chrome} session=${report.sessionType} wayland=${report.isWaylandSession} ` +
		`ozone=${report.ozonePlatform || '(default)'} headlessControl=${report.headlessControl}`
	);
	console.log(`[hidden-capture] url=${report.url}`);
	console.log(`[hidden-capture] source scripts=${(report.sourceFiles || []).join(', ') || '(none)'}`);
	if (report.pageState) {
		console.log(`[hidden-capture] page state=${JSON.stringify(report.pageState)}`);
	}
	console.log(`[hidden-capture] enable-features=${report.featureSwitches && report.featureSwitches.enable}`);
	console.log(`[hidden-capture] disable-features=${report.featureSwitches && report.featureSwitches.disable}`);

	for (const phase of report.phases || []) {
		console.log(
			`[hidden-capture] ${String(phase.label).padEnd(16)} ` +
			`rAF/s=${String(phase.rafPerSecond).padStart(4)} ` +
			`timer/s=${String(phase.timerPerSecond).padStart(4)} ` +
			`chatRows+=${String(phase.rowsAdded).padStart(4)} ` +
			`processed+=${String(phase.messagesProcessed ?? 0).padStart(4)} ` +
			`destinations+=${String(phase.messagesSentToDestinations ?? 0).padStart(4)} ` +
			`visibility=${phase.visibilityState} ` +
			`nativeVisible=${phase.nativeVisible} minimized=${phase.minimized} ` +
			`frames(native/pumped)=${phase.nativeBatchesAdded}/${phase.pumpedBatchesAdded}`
		);
	}

	if (report.rowGrowth) {
		const rows = report.rowGrowth;
		console.log(
			`[hidden-capture] chat rows captured: onScreen=${rows.onScreenRows} ` +
			`occluded=${rows.occludedRows} hidden=${rows.hiddenRows} ` +
			`withZeroFrames=${rows.zeroFrameRows}`
		);
	}
	if (report.pipeline) {
		console.log(
			`[hidden-capture] pipeline destinations: total=${report.pipeline.destinationMessages} ` +
			`occluded=${report.pipeline.occludedDestinationMessages} ` +
			`hidden=${report.pipeline.hiddenDestinationMessages} ` +
			`withZeroFrames=${report.pipeline.zeroFrameDestinationMessages}`
		);
	}

	if (report.backgroundThrottlingEffect) {
		const fx = report.backgroundThrottlingEffect;
		console.log(
			`[hidden-capture] throttling A/B (hidden window): ` +
			`nativeFrames reArmed=${fx.nativeFramesReArmed} throttled=${fx.nativeFramesThrottled}, ` +
			`pumpedFrames reArmed=${fx.pumpedFramesReArmed} throttled=${fx.pumpedFramesThrottled}, ` +
			`reArmingHelped=${fx.helped}`
		);
	}
	if (report.throttleAbNote) {
		console.log(`[hidden-capture] ${report.throttleAbNote}`);
	}

	for (const check of report.checks || []) {
		console.log(`[hidden-capture] ${check.passed ? 'PASS' : 'FAIL'} ${check.id}  (${check.detail})`);
	}

	console.log('[hidden-capture] Summary:', JSON.stringify(report.summary || {}));
}

function run() {
	return new Promise((resolve, reject) => {
		const url = parseUrlArg();
		const args = [
			'.',
			'--running-from-source',
			'--hidden-capture-diagnostics',
			`--hidden-capture-report=${reportPath}`
		];
		if (url) {
			args.push(`--hidden-capture-url=${url}`);
		}
		if (fs.existsSync(path.join(socialStreamRoot, 'sources', 'youtube.js'))) {
			args.push('--filesource', pathToFileURL(socialStreamRoot + path.sep).href);
			args.push(`--hidden-capture-filesource=${socialStreamRoot}`);
		}
		for (const value of process.argv.filter((arg) => arg.startsWith('--source='))) {
			args.push(`--hidden-capture-source=${value.slice('--source='.length)}`);
		}
		const ozonePlatform = process.argv.find((arg) => arg.startsWith('--ozone-platform='));
		if (ozonePlatform) {
			args.push(ozonePlatform);
		}
		if (process.argv.includes('--headless')) {
			args.push('--ssapp-headless-control');
		}
		if (process.argv.includes('--start-hidden')) {
			args.push('--hidden-capture-start-hidden');
		}

		const child = spawn(electronPath, args, {
			cwd: repoRoot,
			stdio: 'inherit',
			env: { ...process.env, SSAPP_USER_DATA_DIR: userDataDir }
		});

		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch (_) { }
			reject(new Error('Timed out waiting for hidden-capture diagnostics to finish.'));
		}, 240000);

		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});

		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

(async () => {
	let exitCode = 1;
	try {
		exitCode = await run();
	} catch (error) {
		console.error('[hidden-capture]', error && error.message ? error.message : error);
	}

	let report = null;
	try {
		report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	} catch (_) { }

	printReport(report);
	console.log(`[hidden-capture] report: ${reportPath}`);

	const passed = !!(report && report.success);
	if (!passed) {
		console.error('[hidden-capture] FAILED');
	} else {
		console.log('[hidden-capture] PASSED');
	}
	process.exit(passed ? 0 : (exitCode || 1));
})();
