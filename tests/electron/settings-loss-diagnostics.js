'use strict';

const fs = require("fs");
const path = require("path");

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function parseJsonFile(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch (_) {
    return null;
  }
}

function parseEmbeddedConfig(rawConfigString) {
  if (!rawConfigString || typeof rawConfigString !== "string") return null;
  try {
    return JSON.parse(rawConfigString);
  } catch (_) {
    return null;
  }
}

function resolveSocialStreamDataDir() {
  const candidates = [];

  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "socialstream"));
  }

  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, "AppData", "Roaming", "socialstream"));
  }

  // Useful fallback in WSL/dev environments for this project.
  candidates.push(path.join("/mnt", "c", "Users", "steve", "AppData", "Roaming", "socialstream"));

  for (const dir of candidates) {
    if (fileExists(dir)) {
      return dir;
    }
  }

  return null;
}

function getRegexResult(source, regex) {
  const match = source.match(regex);
  return match ? match[0] : null;
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCodePathChecks() {
  const popupPath = path.join("resources", "social_stream_fallback", "main", "popup.js");
  const backgroundPath = path.join("resources", "social_stream_fallback", "main", "background.js");
  const mainPath = "main.js";

  const popupSource = readText(popupPath);
  const backgroundSource = readText(backgroundPath);
  const mainSource = readText(mainPath);

  const streamIdGatePattern = /if\s*\(\s*(?:\(\s*response\s*==\s*undefined\s*\)\s*\|\|\s*\(!response\.streamID\)|['"]settings['"]\s+in\s+response\s*&&\s*\(response\.streamID\s*\|\|\s*ssapp\))\s*\)\s*\{/;
  const popupTimeoutPattern = /setTimeout\(\(\)\s*=>\s*\{[\s\S]*?ipcRenderer\.sendSync\('fromPopup',\s*data\);[\s\S]*?\},\s*500\);/;
  const mainImmediateGetSettingsPattern = /if\s*\(value\.cmd\s*==\s*"getSettings"\)\s*\{\s*eventRet\.returnValue\s*=\s*cachedState;/;
  // Tolerant of object-literal formatting: the bundled Social Stream source is regenerated
  // from upstream, and this check failed purely because upstream reformatted the call to
  // sendResponse({ tryAgain: true }) while the guard itself was unchanged.
  const backgroundTryAgainPattern = /if\s*\(\s*!loadedFirst\s*\)\s*\{[\s\S]*?sendResponse\(\s*\{\s*["']?tryAgain["']?\s*:\s*true\s*,?\s*\}\s*\)/;
  const partialThresholdPattern = /PARTIAL_THRESHOLD_RATIO:\s*0\.5/;

  const checks = [
    {
      id: "popup_streamid_gate",
      ok: streamIdGatePattern.test(popupSource),
      detail: "popup waits for stream readiness or ssapp settings payload before hydrating"
    },
    {
      id: "popup_500ms_timeout_fallback",
      ok: popupTimeoutPattern.test(popupSource),
      detail: "500ms callback timeout with sync fallback to fromPopup"
    },
    {
      id: "main_sync_getsettings_returns_cachedstate",
      ok: mainImmediateGetSettingsPattern.test(mainSource),
      detail: getRegexResult(mainSource, mainImmediateGetSettingsPattern)
    },
    {
      id: "background_can_reply_tryAgain_before_loaded",
      ok: backgroundTryAgainPattern.test(backgroundSource),
      detail: "background returns {tryAgain:true} when not loadedFirst"
    },
    {
      id: "main_partial_settings_threshold_is_50pct",
      ok: partialThresholdPattern.test(mainSource),
      detail: getRegexResult(mainSource, partialThresholdPattern)
    }
  ];

  checks.forEach((check) => {
    assertCondition(check.ok, `Expected code path not found: ${check.id}`);
  });

  return checks;
}

function runDiskStateChecks() {
  const dataDir = resolveSocialStreamDataDir();
  if (!dataDir) {
    return {
      dataDir: null,
      savedSyncExists: false,
      savedSyncHasSettings: false,
      embeddedConfigSource: null,
      embeddedConfigBranch: null
    };
  }

  const savedSyncPath = path.join(dataDir, "savedSync.json");
  const configPath = path.join(dataDir, "config.json");

  const savedSync = parseJsonFile(savedSyncPath);
  const config = parseJsonFile(configPath);

  const savedSyncHasSettings = !!(
    savedSync &&
    savedSync.settings &&
    typeof savedSync.settings === "object" &&
    Object.keys(savedSync.settings).length > 0
  );

  let embeddedConfigSource = null;
  let embeddedConfigBranch = null;

  try {
    const rawConfig = config && config.localStorageBackup && config.localStorageBackup.config;
    const embeddedConfig = parseEmbeddedConfig(rawConfig);
    embeddedConfigSource = embeddedConfig && embeddedConfig.__configSource ? embeddedConfig.__configSource : null;
    embeddedConfigBranch = embeddedConfig &&
      embeddedConfig.__configMeta &&
      embeddedConfig.__configMeta.branch
      ? embeddedConfig.__configMeta.branch
      : null;
  } catch (_) {
    // No-op.
  }

  return {
    dataDir,
    savedSyncExists: !!savedSync,
    savedSyncHasSettings,
    embeddedConfigSource,
    embeddedConfigBranch
  };
}

function main() {
  const checks = runCodePathChecks();
  const disk = runDiskStateChecks();

  console.log("settings-loss-diagnostics");
  console.log("");
  console.log("Code Path Checks (issue-signature assertions):");
  checks.forEach((check) => {
    console.log(`- PASS ${check.id}`);
  });

  console.log("");
  console.log("Disk State Checks:");
  if (!disk.dataDir) {
    console.log("- dataDir: not found");
    console.log("- savedSync: not validated (missing data dir)");
  } else {
    console.log(`- dataDir: ${disk.dataDir}`);
    console.log(`- savedSync exists: ${disk.savedSyncExists}`);
    console.log(`- savedSync has non-empty settings: ${disk.savedSyncHasSettings}`);
    console.log(`- embedded config source: ${disk.embeddedConfigSource || "unknown"}`);
    console.log(`- embedded config branch: ${disk.embeddedConfigBranch || "unknown"}`);
  }

  console.log("");
  console.log("Interpretation:");
  console.log("- PASS on all code checks means the known Electron race/gating signatures are present.");
  console.log("- If savedSync has settings, popup-reset symptoms are likely hydration/IPC timing, not true disk loss.");
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error("settings-loss-diagnostics: failed");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
