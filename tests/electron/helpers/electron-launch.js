'use strict';

// Shared Electron launch arguments for the specs in tests/electron.
//
// Electron's ozone auto-detection does not reach `ready` on a Wayland session
// when running from source: app.whenReady() never resolves, so nothing a spec
// waits for ever happens. The process stays alive throughout, which makes the
// failure read as though the feature under test is broken rather than the
// launch — an ECONNREFUSED against a port that was never going to be bound.
// Pinning x11 (XWayland) avoids it.
//
// Ubuntu 24.04 also restricts unprivileged user namespaces via AppArmor
// (kernel.apparmor_restrict_unprivileged_userns=1), which breaks Chromium's
// sandbox unless the bundled chrome-sandbox is root-owned and setuid. Test
// runners rarely fix that up, so --no-sandbox is included by default; pass
// { sandbox: true } to keep it enabled where the environment supports it.
//
// Linux only. Ozone does not exist on macOS or Windows, and several specs
// previously hardcoded these switches unconditionally.
function linuxLaunchArgs({ sandbox = false } = {}) {
	if (process.platform !== 'linux') return [];
	return sandbox ? ['--ozone-platform=x11'] : ['--no-sandbox', '--ozone-platform=x11'];
}

// SSAPP_TEST_EXECUTABLE selects a packaged app; SSAPP_TEST_BUNDLED=1 also
// selects its bundled Social Stream pages instead of the sibling checkout.
function electronTestTarget(sourceBase) {
	const executable = process.env.SSAPP_TEST_EXECUTABLE;
	const bundled = process.env.SSAPP_TEST_BUNDLED === '1';
	if (bundled && !executable) throw new Error('Bundled checks require SSAPP_TEST_EXECUTABLE');
	return {
		executablePath: executable ? require('path').resolve(executable) : require('electron'),
		args: [
			...(executable ? [] : ['.']),
			...(bundled ? ['--preferlocalassets'] : ['--running-from-source', '--filesource=' + sourceBase]),
		],
	};
}

async function electronTestRuntime(application) {
	const runtime = await application.evaluate(({ app }) => ({
		packaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(),
		executable: process.execPath, electron: process.versions.electron,
	}));
	if (runtime.packaged !== !!process.env.SSAPP_TEST_EXECUTABLE) {
		throw new Error('Test launched the wrong application type: ' + JSON.stringify(runtime));
	}
	return runtime;
}

async function electronTestSourceBase(main, sourceBase) {
	if (process.env.SSAPP_TEST_BUNDLED !== '1') return sourceBase;
	const resolved = await main.evaluate(() => window.ssappFallback.resolveUrl('dock.html', { branch: 'main' }));
	if (!resolved?.url) throw new Error('Packaged Social Stream pages are unavailable');
	return new URL('.', resolved.url).href;
}

module.exports = { linuxLaunchArgs, electronTestTarget, electronTestRuntime, electronTestSourceBase };
