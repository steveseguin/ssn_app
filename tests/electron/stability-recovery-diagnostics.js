'use strict';

const fs = require('fs');
const path = require('path');

function readText(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

function assertCondition(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function run() {
	const repoRoot = path.resolve(__dirname, '..', '..');
	const mainPath = path.join(repoRoot, 'main.js');
	const source = readText(mainPath);

	const checks = [
		{
			id: 'stability_runtime_state_key',
			ok: /const STABILITY_RUNTIME_STORE_KEY = 'stabilityRuntime';/.test(source),
			note: 'Runtime stability store key exists'
		},
		{
			id: 'stability_startup_initializer',
			ok: /const stabilityRuntimeStateAtLaunch = initializeStabilityRuntimeForStartup\(\);/.test(source),
			note: 'Startup initializes runtime stability state'
		},
		{
			id: 'stability_gpu_profile_applied',
			ok: /if \(!stabilityGpuProfile\.disableGpuRasterization\)/.test(source) &&
				/if \(!stabilityGpuProfile\.disableIgnoreGpuBlocklist\)/.test(source) &&
				/if \(!IS_MAC_BALANCED_MODE && !stabilityGpuProfile\.disableUnsafeWebGpu\)/.test(source),
			note: 'GPU fallback profile gates aggressive flags'
		},
		{
			id: 'crash_hooks_present',
			ok: /app\.on\('render-process-gone'/.test(source) && /app\.on\('child-process-gone'/.test(source),
			note: 'Crash signals are captured from process-gone hooks'
		},
		{
			id: 'graceful_markers_present',
			ok: /markStabilitySessionGraceful\('quitApp'\)/.test(source) &&
				/markStabilitySessionGraceful\('will-quit'\)/.test(source) &&
				/markStabilitySessionGraceful\('session-switch-restart'\)/.test(source),
			note: 'Graceful markers are present for quit/restart paths'
		},
		{
			id: 'settings_quality_gate_present',
			ok: /function describeCachedStateQuality\(/.test(source) &&
				/function shouldRecoverCachedStateFromBackups\(/.test(source) &&
				/function persistCachedStateSafely\(/.test(source),
			note: 'Quality scoring and guarded persistence helpers exist'
		},
		{
			id: 'storage_paths_use_recovery_gate',
			ok: /applyRecoveredCachedState\(diskResult, "storageGet"\)/.test(source) &&
				/applyRecoveredCachedState\(diskResult, "storageGetAsync"\)/.test(source) &&
				/applyRecoveredCachedState\(diskResult, "getSettings"\)/.test(source),
			note: 'storageGet/storageGetAsync/getSettings invoke recovery gate'
		},
		{
			id: 'startup_notice_hooked',
			ok: /function queueStabilityStartupNotice\(/.test(source) &&
				/createWindow\(Argv, false, true\);\s*queueStabilityStartupNotice\(\);/.test(source),
			note: 'Stability startup notice is queued after window creation'
		}
	];

	checks.forEach((check) => {
		assertCondition(check.ok, `Missing expected stability/recovery safeguard: ${check.id}`);
	});

	console.log('stability-recovery-diagnostics');
	console.log('');
	console.log('Code Path Checks:');
	checks.forEach((check) => {
		console.log(`- PASS ${check.id} :: ${check.note}`);
	});
	console.log('');
	console.log('Interpretation:');
	console.log('- PASS indicates crash-loop mitigation and partial-settings recovery gates are wired into runtime and storage paths.');
}

try {
	run();
	process.exit(0);
} catch (error) {
	console.error('stability-recovery-diagnostics: failed');
	console.error(error && error.stack ? error.stack : error);
	process.exit(1);
}
