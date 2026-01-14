"use strict";

/**
 * Stub module for TikTok signing helper.
 * 
 * This file is used when the private tiktok-signing submodule is not available.
 * TikTok WebSocket signing functionality will be disabled.
 * 
 * To enable full TikTok signing support, you need access to the private
 * ssn-tiktok-signer repository.
 */

const STUB_WARNING = "[TikTok Signing] This is a stub module - TikTok WebSocket signing is not available in this build.";

let hasWarned = false;
function warnOnce() {
	if (!hasWarned) {
		console.warn(STUB_WARNING);
		hasWarned = true;
	}
}

/**
 * Stub: Always throws an error indicating signing is unavailable.
 */
async function injectCrawlerBundle(win) {
	warnOnce();
	throw new Error("TikTok signing module not available - signing functionality disabled in this build.");
}

/**
 * Stub: Always throws an error indicating signing is unavailable.
 */
async function generateSigningParameters(win, options = {}) {
	warnOnce();
	throw new Error("TikTok signing module not available - signing functionality disabled in this build.");
}

/**
 * Simple 19 digit numeric id generator (this part can still work).
 */
function randomDeviceId() {
	let out = "";
	while (out.length < 19) {
		const chunk = Math.floor(Math.random() * 1e12).toString().padStart(12, "0");
		out += chunk;
	}
	return out.slice(0, 19);
}

/**
 * Stub: Returns empty string.
 */
async function readSessionIdFromSession(win) {
	warnOnce();
	return "";
}

module.exports = {
	injectCrawlerBundle,
	generateSigningParameters,
	randomDeviceId,
	readSessionIdFromSession
};
