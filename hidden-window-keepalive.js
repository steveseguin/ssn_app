'use strict';

// Keeps capture windows working when they are not on screen.
//
// Chromium drives requestAnimationFrame from compositor frames, and a window nobody is
// looking at does not reliably get frames. `backgroundThrottling: false` is not enough on
// its own: it keeps DOM timers running, but it does not make frames appear. Measured on
// Electron 38 with a source window created hidden, which is what a user gets whenever a
// source's window is switched off and what every window gets under
// --ssapp-headless-control:
//
//   X11 desktop, window created hidden ....... ~1 compositor frame/s
//   Headless control mode .................... 0 compositor frames/s
//   Bare hidden-from-birth BrowserWindow ..... 0 rAF/s
//
// A window that was on screen and is then hidden fares better, but on Wayland it still
// depends on the compositor: rAF ultimately comes from wl_surface.frame callbacks, and
// compositors withhold those for surfaces they consider invisible - hidden, minimized,
// fully occluded, or on another workspace. Chromium 115+ also ships EvictionThrottlesDraw,
// which keeps draws throttled once a surface has been evicted.
//
// Chat pages care because they append new message nodes from rAF-scheduled work. When
// frames stop, YouTube live chat stops growing its DOM, the capture script sees no
// mutations, and chat silently dies until the window is brought back to the foreground.
//
// The fix is FRAME_PUMP_SCRIPT, injected into capture pages: it queues
// requestAnimationFrame callbacks itself and runs them from a timer whenever real frames
// stop arriving. Timers keep running when frames do not, so it holds no matter what the
// compositor decides to do with the window, and it stays dormant while frames flow
// normally. Measured with a real YouTube live chat window receiving zero compositor frames:
// messages kept arriving in the DOM, driven entirely by the pump.
//
// Two other levers were tried and dropped because neither changed frame delivery in the
// real app: webContents.beginFrameSubscription() (inconsistent - 60 frames/s in one session,
// nothing in the next) and re-applying webContents.setBackgroundThrottling(false) after the
// hide (which does lift a bare hidden window from 0 to 60 frames/s in isolation, but made no
// difference to an actual source window).

const FRAME_PUMP_STALL_MS = 100; // treat frames as stalled after this long with work queued
const FRAME_PUMP_CHECK_MS = 50; // how often the fallback timer looks for stalled work

// Runs in the page's main world. Must stay self-contained and must never throw into the
// page, since it is injected into third-party chat pages.
const FRAME_PUMP_SCRIPT = `(function () {
	try {
		if (window.__ssnFramePump) { return "already-installed"; }
		var STALL_MS = ${FRAME_PUMP_STALL_MS};
		var CHECK_MS = ${FRAME_PUMP_CHECK_MS};

		var nativeRequest = window.requestAnimationFrame;
		var nativeCancel = window.cancelAnimationFrame;
		if (typeof nativeRequest !== "function") { return "unsupported"; }
		nativeRequest = nativeRequest.bind(window);
		nativeCancel = typeof nativeCancel === "function" ? nativeCancel.bind(window) : function () { };

		var now = function () {
			try { return performance.now(); } catch (error) { return Date.now(); }
		};

		var queue = new Map();
		var running = null;
		var nextHandle = 1;
		var nativePending = false;
		var lastRun = now();
		var pumpedBatches = 0;
		var nativeBatches = 0;

		function run(timestamp, viaPump) {
			lastRun = now();
			if (viaPump) { pumpedBatches++; } else { nativeBatches++; }
			if (!queue.size) { return; }
			// Swap the queue first so callbacks that re-register land in the next batch.
			var due = queue;
			queue = new Map();
			running = due;
			try {
				// Map.forEach skips entries deleted before it reaches them, so a callback
				// cancelling a later callback in this same batch works as it does natively.
				due.forEach(function (callback) {
					try {
						callback(timestamp);
					} catch (error) {
						// Match native behaviour: keep running the batch, still report the error.
						setTimeout(function () { throw error; }, 0);
					}
				});
			} finally {
				running = null;
			}
		}

		function scheduleNative() {
			if (nativePending) { return; }
			nativePending = true;
			nativeRequest(function (timestamp) {
				nativePending = false;
				run(timestamp, false);
			});
		}

		function patched(callback) {
			if (typeof callback !== "function") {
				throw new TypeError("Failed to execute 'requestAnimationFrame': parameter 1 is not of type 'Function'.");
			}
			var handle = nextHandle++;
			queue.set(handle, callback);
			scheduleNative();
			return handle;
		}

		function patchedCancel(handle) {
			if (queue.delete(handle)) { return; }
			if (running && running.delete(handle)) { return; }
			// Not ours: could be a handle handed out by the real API before we took over.
			try { nativeCancel(handle); } catch (error) { }
		}

		var pump = setInterval(function () {
			if (!queue.size) { return; }
			if ((now() - lastRun) < STALL_MS) { return; }
			run(now(), true);
		}, CHECK_MS);

		// Keep the swap as unremarkable as possible to page-side fingerprinting.
		function disguise(fn, name) {
			try {
				Object.defineProperty(fn, "name", { value: name, configurable: true });
				Object.defineProperty(fn, "length", { value: 1, configurable: true });
				Object.defineProperty(fn, "toString", {
					value: function () { return "function " + name + "() { [native code] }"; },
					writable: true,
					configurable: true
				});
			} catch (error) { }
		}
		disguise(patched, "requestAnimationFrame");
		disguise(patchedCancel, "cancelAnimationFrame");

		window.requestAnimationFrame = patched;
		window.cancelAnimationFrame = patchedCancel;

		window.__ssnFramePump = {
			version: 1,
			stats: function () {
				return {
					queued: queue.size,
					pumpedBatches: pumpedBatches,
					nativeBatches: nativeBatches,
					stalledForMs: Math.round(now() - lastRun)
				};
			},
			dispose: function () {
				try { clearInterval(pump); } catch (error) { }
				try {
					window.requestAnimationFrame = nativeRequest;
					window.cancelAnimationFrame = nativeCancel;
				} catch (error) { }
				try { delete window.__ssnFramePump; } catch (error) { }
			}
		};

		return "installed";
	} catch (error) {
		return "error: " + ((error && error.message) ? error.message : String(error));
	}
})();`;

// Escape hatch in case the pump ever misbehaves on a page: SSAPP_DISABLE_FRAME_PUMP=1
function isFramePumpDisabled() {
	try {
		return process.env.SSAPP_DISABLE_FRAME_PUMP === '1';
	} catch (_) {
		return false;
	}
}

function isWaylandSession() {
	if (process.platform !== 'linux') return false;
	try {
		if (process.env.WAYLAND_DISPLAY) return true;
		return String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland';
	} catch (_) {
		return false;
	}
}

function isUsableWebContents(webContents) {
	try {
		return !!webContents && typeof webContents.executeJavaScript === 'function' && !webContents.isDestroyed();
	} catch (_) {
		return false;
	}
}

function isUsableFrame(frame) {
	try {
		if (!frame || typeof frame.executeJavaScript !== 'function') return false;
		if (typeof frame.isDestroyed === 'function' && frame.isDestroyed()) return false;
		const url = typeof frame.url === 'string' ? frame.url : '';
		return !!url && url !== 'about:blank';
	} catch (_) {
		return false;
	}
}

// Installs the pump in the main frame and every subframe (YouTube serves live chat from
// an iframe on watch pages, and each frame has its own requestAnimationFrame).
function installFramePump(webContents, onResult) {
	if (isFramePumpDisabled()) return;
	if (!isUsableWebContents(webContents)) return;

	const report = (scope, result) => {
		if (typeof onResult === 'function') {
			try { onResult(scope, result); } catch (_) { }
		}
	};

	webContents
		.executeJavaScript(FRAME_PUMP_SCRIPT, true)
		.then((result) => report('main', result))
		.catch(() => { });

	let frames = [];
	try {
		const rootFrame = webContents.mainFrame;
		frames = rootFrame && Array.isArray(rootFrame.framesInSubtree) ? rootFrame.framesInSubtree : [];
	} catch (_) {
		frames = [];
	}

	for (const frame of frames) {
		if (!isUsableFrame(frame)) continue;
		if (!frame.parent) continue; // main frame already handled above
		try {
			frame
				.executeJavaScript(FRAME_PUMP_SCRIPT, true)
				.then((result) => report(frame.url || 'frame', result))
				.catch(() => { });
		} catch (_) { }
	}
}

function installFramePumpInFrame(frame) {
	if (isFramePumpDisabled()) return;
	if (!isUsableFrame(frame)) return;
	try {
		frame.executeJavaScript(FRAME_PUMP_SCRIPT, true).catch(() => { });
	} catch (_) { }
}

// Wires the pump into a source window for its whole lifetime. Reinstalls after every
// navigation, since a fresh document gets a fresh requestAnimationFrame.
function attachFramePump(view, options = {}) {
	if (isFramePumpDisabled()) return () => { };
	const webFrameMain = options.webFrameMain || null;
	const log = typeof options.log === 'function' ? options.log : () => { };
	if (!view || typeof view.once !== 'function') return () => { };

	const webContents = view.webContents;
	if (!isUsableWebContents(webContents)) return () => { };

	const onDomReady = () => {
		installFramePump(webContents, (scope, result) => {
			if (result !== 'already-installed') {
				log(`[FramePump] ${result} (${scope})`);
			}
		});
	};

	const onFrameFinishLoad = (_event, isMainFrame, frameProcessId, frameRoutingId) => {
		if (isMainFrame || !webFrameMain) return;
		try {
			installFramePumpInFrame(webFrameMain.fromId(frameProcessId, frameRoutingId));
		} catch (_) { }
	};

	webContents.on('dom-ready', onDomReady);
	webContents.on('did-frame-finish-load', onFrameFinishLoad);

	const detach = () => {
		try { webContents.removeListener('dom-ready', onDomReady); } catch (_) { }
		try { webContents.removeListener('did-frame-finish-load', onFrameFinishLoad); } catch (_) { }
	};

	try { view.once('closed', detach); } catch (_) { }

	// The window may already be loaded by the time we get here.
	try {
		if (!webContents.isLoadingMainFrame()) onDomReady();
	} catch (_) { }

	return detach;
}

function readFramePumpStats(webContents) {
	if (!isUsableWebContents(webContents)) return Promise.resolve(null);
	return webContents
		.executeJavaScript('(window.__ssnFramePump ? window.__ssnFramePump.stats() : null)', true)
		.catch(() => null);
}

module.exports = {
	FRAME_PUMP_SCRIPT,
	FRAME_PUMP_STALL_MS,
	FRAME_PUMP_CHECK_MS,
	attachFramePump,
	installFramePump,
	installFramePumpInFrame,
	isFramePumpDisabled,
	isWaylandSession,
	readFramePumpStats
};
