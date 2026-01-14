#!/usr/bin/env node
"use strict";

/**
 * Pre-build script to check for optional submodules.
 * If the TikTok signing submodule is not available, copies the stub file.
 */

const fs = require("fs");
const path = require("path");

const SIGNER_PATH = path.join(__dirname, "..", "tiktok-signing", "electron-signer.js");
const STUB_PATH = path.join(__dirname, "fallbacks", "electron-signer.stub.js");
const TIKTOK_SIGNING_DIR = path.join(__dirname, "..", "tiktok-signing");

function checkTikTokSigningModule() {
	console.log("[check-submodules] Checking for TikTok signing module...");

	if (fs.existsSync(SIGNER_PATH)) {
		// Check if it's the real file or the stub
		const content = fs.readFileSync(SIGNER_PATH, "utf8");
		if (content.includes("This is a stub module")) {
			console.warn("[check-submodules] WARNING: TikTok signing module is a stub - WebSocket signing will be disabled.");
		} else {
			console.log("[check-submodules] TikTok signing module found.");
		}
		return;
	}

	// Real signer not found - copy stub if available
	if (fs.existsSync(STUB_PATH)) {
		console.warn("[check-submodules] WARNING: TikTok signing module not found (private submodule not available).");
		console.warn("[check-submodules] Copying stub file - TikTok WebSocket signing will be disabled.");
		// Ensure directory exists
		if (!fs.existsSync(TIKTOK_SIGNING_DIR)) {
			fs.mkdirSync(TIKTOK_SIGNING_DIR, { recursive: true });
		}
		fs.copyFileSync(STUB_PATH, SIGNER_PATH);
	} else {
		console.warn("[check-submodules] WARNING: Neither TikTok signing module nor stub found.");
		console.warn("[check-submodules] TikTok signing features will not be available.");
	}
}

// Run checks
checkTikTokSigningModule();

console.log("[check-submodules] Submodule check complete.");
