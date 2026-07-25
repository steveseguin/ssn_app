'use strict';

// Long-running check that capture in hidden source windows does not quietly stop after a
// while. Creates one real source window per URL, hides each through the same path the hide
// button uses, then samples every minute.
//
//   node tests/electron/hidden-capture-soak.js --minutes=60 \
//     --url="https://www.youtube.com/live_chat?is_popout=1&v=VIDEO_ID" \
//     --url="https://www.twitch.tv/popout/CHANNEL/chat?popout=" \
//     --url="https://kick.com/popout/CHANNEL/chat"
//
// Add --headless to soak the way a server install runs.
// Results stream to a .jsonl file so a run can be inspected while it is still going.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const electronPath = require('electron');

const repoRoot = path.resolve(__dirname, '..', '..');
const stamp = Date.now();
const reportPath = process.env.SOAK_REPORT || path.join(os.tmpdir(), `ssapp-hidden-capture-soak-${stamp}.jsonl`);
const userDataDir = path.join(os.tmpdir(), `ssapp-soak-profile-${stamp}`);

function argValues(name) {
	return process.argv
		.filter((value) => value.startsWith(`--${name}=`))
		.map((value) => value.slice(name.length + 3));
}

const urls = argValues('url');
const minutesArg = argValues('minutes')[0];
const minutes = Math.max(1, parseInt(minutesArg || '30', 10) || 30);

const args = [
	'.',
	'--running-from-source',
	'--hidden-capture-soak',
	`--hidden-capture-soak-minutes=${minutes}`,
	`--hidden-capture-soak-report=${reportPath}`
];
for (const url of urls) {
	args.push(`--hidden-capture-soak-url=${url}`);
}
if (process.argv.includes('--headless')) {
	args.push('--ssapp-headless-control');
}
if (process.argv.includes('--start-hidden')) {
	args.push('--hidden-capture-soak-start-hidden');
}

console.log(`[soak] ${minutes} minute(s), ${urls.length || 1} window(s)`);
console.log(`[soak] report: ${reportPath}`);

// SSAPP_USER_DATA_DIR, not --user-data-dir: the app overrides the latter during startup.
const child = spawn(electronPath, args, {
	cwd: repoRoot,
	stdio: 'inherit',
	env: { ...process.env, SSAPP_USER_DATA_DIR: userDataDir }
});

// Generous ceiling: the run itself plus startup, page loads and teardown.
const timer = setTimeout(() => {
	console.error('[soak] timed out; killing');
	try { child.kill(); } catch (_) { }
}, (minutes + 8) * 60000);

child.on('exit', (code) => {
	clearTimeout(timer);
	let summary = null;
	try {
		const lines = fs.readFileSync(reportPath, 'utf8').trim().split('\n');
		for (const line of lines) {
			const entry = JSON.parse(line);
			if (entry.type === 'summary') summary = entry;
		}
	} catch (_) { }

	if (!summary) {
		console.error('[soak] no summary written — the run did not finish');
		process.exit(code || 1);
	}

	console.log('[soak] result:');
	for (const w of summary.windows) {
		const state = w.stalled ? 'STALLED' : (w.inconclusive ? 'NO DATA' : 'ok     ');
		console.log(
			`[soak]   ${state} ${w.url}\n` +
			`[soak]           rows=${w.rowsWhileHidden} minutesWithRows=${w.minutesWithRows}/${w.samples} ` +
			`minRaf=${w.minRafPerSecond}/s minTimer=${w.minTimerPerSecond}/s quietTail=${w.quietTailMinutes}min errors=${w.errors}` +
			(w.inconclusive ? `\n[soak]           page was: ${JSON.stringify(w.snapshot).slice(0, 200)}` : '')
		);
	}
	console.log(`[soak] ${summary.success ? 'PASSED' : 'FAILED'} after ${summary.minutes} minutes`);
	process.exit(summary.success ? 0 : 1);
});
