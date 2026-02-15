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
	const passwordDeleteMatches = source.match(/delete cachedState\.password;/g) || [];

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
			id: 'capture_events_opt_out_model',
			ok: /function isCaptureEventsEnabled\(\)\s*\{[\s\S]*?if \(!settings \|\| typeof settings !== ['"]object['"]\) return true;[\s\S]*?hasOwnProperty\.call\(settings, ['"]hideevents['"]\)[\s\S]*?hasOwnProperty\.call\(settings, ['"]disableevents['"]\)[\s\S]*?hasOwnProperty\.call\(settings, ['"]disablecaptureevents['"]\)[\s\S]*?return true;[\s\S]*?\}/.test(source),
			note: 'Non-gift capture defaults ON unless explicit disable keys are present'
		},
		{
			id: 'storage_paths_use_recovery_gate',
			ok: /queueCachedStateRecovery\("storageGet"\)/.test(source) &&
				/await recoverCachedStateIfNeeded\("storageGetAsync"\)/.test(source) &&
				/applyRecoveredCachedState\(diskResult, "getSettings"\)/.test(source),
			note: 'storageGet defers recovery while storageGetAsync/getSettings keep recovery gate'
		},
		{
			id: 'clear_data_rebuilds_baseline_and_clears_backup',
			ok: /cachedStatePersistenceBaseline = null;[\s\S]*?createCachedStateCandidate\(cachedState, "runtime-reset", Date\.now\(\)\)[\s\S]*?const \{ mainPath: savedSyncPath, bakPath: savedSyncBackupPath \} = getSavedSyncPaths\(\);[\s\S]*?fs\.unlinkSync\(savedSyncBackupPath\)/.test(source),
			note: 'Explicit reset replaces baseline and removes stale savedSync backup'
		},
		{
			id: 'recoverable_state_candidate_allows_state_flag',
			ok: /const hasRecoverableData = hasCoreData \|\| hasStateFlag;/.test(source) &&
				/if \(!metrics\.hasRecoverableData\) return null;/.test(source),
			note: 'Recovery candidate creation accepts state-only snapshots'
		},
		{
			id: 'older_recovery_candidate_preserves_in_memory_values',
			ok: /const preserveExistingOnConflict = incomingTimestamp > 0 && baselineTimestamp > 0 && incomingTimestamp < baselineTimestamp && currentMetrics\.hasCoreData;/.test(source) &&
				/merged = \{ \.\.\.incoming, \.\.\.cachedState \};/.test(source) &&
				/merged\.settings = \{ \.\.\.incomingSettings, \.\.\.existingSettings \};/.test(source),
			note: 'Older candidates fill gaps but do not overwrite newer in-memory keys'
		},
		{
			id: 'deferred_recovery_queue_guard',
			ok: /let cachedStateRecoveryQueued = false;/.test(source) &&
				/function queueCachedStateRecovery\(reason = ""\) \{[\s\S]*?if \(cachedStateRecoveryQueued\) return;[\s\S]*?cachedStateRecoveryQueued = true;[\s\S]*?await recoverCachedStateIfNeeded\(reason\);[\s\S]*?cachedStateRecoveryQueued = false;[\s\S]*?\}/.test(source),
			note: 'Deferred recovery is deduplicated and releases queue guard after completion'
		},
		{
			id: 'recovery_pipeline_checks_disk_then_local_backups',
			ok: /async function recoverCachedStateIfNeeded\(reason = ""\) \{[\s\S]*?loadCachedStateWithBackupSource\(\{ logSelection: true, updateBaseline: false \}\)[\s\S]*?readLocalStorageMirror\(mainWindow\)[\s\S]*?hydrateCachedStateFromStoreBackup\(\)[\s\S]*?\}/.test(source),
			note: 'Recovery pipeline checks disk, localStorage mirror, then store backup'
		},
		{
			id: 'password_null_clears_cached_state_key',
			ok: passwordDeleteMatches.length >= 4,
			note: 'Invalid/null password payloads clear cachedState.password across save/update handlers'
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
	console.log('- PASS indicates crash-loop mitigation plus stale-settings recovery/merge safeguards are wired into reset, storage, and deferred recovery flows.');
}

try {
	run();
	process.exit(0);
} catch (error) {
	console.error('stability-recovery-diagnostics: failed');
	console.error(error && error.stack ? error.stack : error);
	process.exit(1);
}
