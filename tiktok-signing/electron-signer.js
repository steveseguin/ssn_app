"use strict";

/**
 * Helper utilities for running the bundled ByteDance signer (berrrk.js)
 * inside an Electron BrowserWindow.
 *
 * Usage overview:
 *
 * ```js
 * const {BrowserWindow} = require("electron");
 * const {injectCrawlerBundle, generateSigningParameters} = require("./electron-signer");
 *
 * async function openLoginAndCollect(roomId) {
 *   const win = new BrowserWindow({
 *     width: 1024,
 *     height: 768,
 *     webPreferences: {
 *       preload: path.join(__dirname, "preload.js"),
 *       contextIsolation: true,
 *       nodeIntegration: false
 *     }
 *   });
 *
 *   await win.loadURL("https://www.tiktok.com/login");
 *   await injectCrawlerBundle(win);
 *   // Wait for the user to finish authentication...
 *   return generateSigningParameters(win, {
 *     roomId,
 *     email: "user@email.com",
 *     browserName: "Electron",
 *     browserVersion: process.versions.electron,
 *     userAgent: win.webContents.getUserAgent()
 *   });
 * }
 * ```
 */

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_BUNDLE_PATH = path.join(__dirname, "berrrk.js");
const PAGE_LOAD_TIMEOUT_MS = 20000;

function getWebContents(win) {
  if (!win || typeof win !== "object") {
    return null;
  }
  const wc = win.webContents;
  if (!wc || typeof wc !== "object") {
    return null;
  }
  if (typeof wc.isDestroyed === "function" && wc.isDestroyed()) {
    return null;
  }
  return wc;
}

async function waitForDomReady(win, timeout = PAGE_LOAD_TIMEOUT_MS) {
  const wc = getWebContents(win);
  if (!wc) {
    throw new Error("BrowserWindow webContents unavailable or already destroyed.");
  }

  const loading =
    (typeof wc.isLoadingMainFrame === "function" && wc.isLoadingMainFrame()) ||
    (typeof wc.isLoading === "function" && wc.isLoading());
  if (!loading) {
    return;
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        wc.removeListener("did-finish-load", onFinish);
        wc.removeListener("did-fail-load", onFail);
        wc.removeListener("destroyed", onDestroyed);
      } catch (_) {}
      clearTimeout(timer);
    };

    const onFinish = () => {
      cleanup();
      resolve();
    };

    const onFail = (_event, errorCode, errorDesc, failedUrl, isMainFrame) => {
      if (isMainFrame === false) {
        return;
      }
      const meta =
        typeof failedUrl === "string" && failedUrl
          ? ` (${failedUrl})`
          : "";
      cleanup();
      reject(
        new Error(
          `Navigation failed${meta}: ${errorDesc || errorCode || "Unknown error"}`
        )
      );
    };

    const onDestroyed = () => {
      cleanup();
      reject(new Error("TikTok window closed before it finished loading."));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the TikTok window to finish loading."));
    }, timeout);

    wc.once("did-finish-load", onFinish);
    wc.once("did-fail-load", onFail);
    wc.once("destroyed", onDestroyed);
  });
}

/**
 * Simple 19 digit numeric id generator that mirrors the format TikTok expects.
 */
function randomDeviceId() {
  let out = "";
  while (out.length < 19) {
    const chunk = crypto.randomInt(0, 1e12).toString().padStart(12, "0");
    out += chunk;
  }
  return out.slice(0, 19);
}

/**
 * Execute JavaScript inside the provided BrowserWindow.
 * @param {Electron.BrowserWindow} win
 * @param {string} source
 * @returns {Promise<*>}
 */
async function exec(win, source, attempt = 0) {
  if (!win || win.isDestroyed()) {
    throw new Error("BrowserWindow is missing or already destroyed.");
  }
  const wc = getWebContents(win);
  if (!wc) {
    throw new Error("BrowserWindow webContents unavailable or already destroyed.");
  }
  try {
    return await wc.executeJavaScript(source, true);
  } catch (error) {
    const url = typeof wc.getURL === "function" ? wc.getURL() : "";
    const detail = error && (error.stack || error.message) ? error.stack || error.message : String(error);
    const shouldRetry =
      attempt === 0 &&
      /Script failed to execute/i.test(detail || "") &&
      (typeof wc.isLoading === "function" ? wc.isLoading() : true);
    if (shouldRetry) {
      try {
        await waitForDomReady(win);
      } catch (waitError) {
        const waitMessage =
          waitError && (waitError.stack || waitError.message)
            ? waitError.stack || waitError.message
            : String(waitError);
        throw new Error(
          `[tiktok-signing] Signing window is still navigating: ${waitMessage} (original error: ${detail})`
        );
      }
      return exec(win, source, attempt + 1);
    }
    throw new Error(
      `[tiktok-signing] executeJavaScript failed${url ? ` on ${url}` : ""}: ${detail}`
    );
  }
}

/**
 * Injects the obfuscated ByteDance crawler bundle (berrrk.js) into the current page.
 * Calling this multiple times is safe; the bundle is only evaluated once per page.
 *
 * @param {Electron.BrowserWindow} win
 * @param {{bundlePath?: string}=} options
 */
async function injectCrawlerBundle(win, options = {}) {
  await waitForDomReady(win);
  const bundleAlreadyLoaded = await exec(
    win,
    "Boolean(window.__tiktokCrawlerReady && window.byted_acrawler)"
  );
  if (bundleAlreadyLoaded) {
    return;
  }

  const bundlePath = options.bundlePath || DEFAULT_BUNDLE_PATH;
  const source = await fs.readFile(bundlePath, "utf8");
  await exec(win, source);
  await waitForDomReady(win);

  const ready = await exec(
    win,
    "window.__tiktokCrawlerReady = Boolean(window.byted_acrawler); window.__tiktokCrawlerReady;"
  );
  if (!ready) {
    throw new Error(
      "berrrk.js did not expose window.byted_acrawler. Ensure the window is a real TikTok page."
    );
  }
}

function normalizePathWithQuery(input, baseUrl) {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  if (trimmed.startsWith("?")) {
    return `/${trimmed}`;
  }
  try {
    const parsed = new URL(trimmed, baseUrl || "https://www.tiktok.com/");
    return parsed.pathname + parsed.search;
  } catch (_) {
    return null;
  }
}

function ensureRoomId(pathWithQuery, roomId) {
  const fallback = typeof pathWithQuery === "string" && pathWithQuery.trim() ? pathWithQuery : "/";
  if (!roomId || /(\?|&)room_id=/.test(fallback)) {
    return fallback;
  }
  const separator = fallback.includes("?") ? "&" : "?";
  return `${fallback}${separator}room_id=${encodeURIComponent(roomId)}`;
}

function deriveSigningPath(win, roomId, urlToSign, explicitPath) {
  const currentUrl = (win && win.webContents && typeof win.webContents.getURL === "function"
    ? win.webContents.getURL()
    : "https://www.tiktok.com/") || "https://www.tiktok.com/";
  const baseForRelative = currentUrl && currentUrl !== "about:blank" ? currentUrl : "https://www.tiktok.com/";
  const explicit = normalizePathWithQuery(explicitPath, baseForRelative);
  const override = normalizePathWithQuery(urlToSign, baseForRelative);
  const fallback = normalizePathWithQuery(baseForRelative, baseForRelative) || "/";
  return ensureRoomId(explicit || override || fallback, roomId);
}

async function readMsTokenFromSession(win) {
  try {
    const electronSession = win && win.webContents ? win.webContents.session : null;
    if (!electronSession || !electronSession.cookies) {
      return "";
    }
    const cookies = await electronSession.cookies.get({
      url: "https://www.tiktok.com/",
      name: "msToken"
    });
    if (!cookies || !cookies.length) {
      return "";
    }
    const cookie = cookies.find((entry) => entry && entry.name === "msToken");
    if (!cookie || !cookie.value) {
      return "";
    }
    return decodeURIComponent(cookie.value);
  } catch (error) {
    console.warn("[tiktok-signing] Failed to read msToken from Electron session:", error);
    return "";
  }
}

/**
 * Generates the full parameter payload (device id, msToken, X-Bogus, X-Gnarly)
 * inside the provided BrowserWindow.
 *
 * Requirements:
 *   - The window must already be navigated to a TikTok origin where the user is signed in.
 *   - `injectCrawlerBundle` must have been called earlier for the same window.
 *
 * @param {Electron.BrowserWindow} win
 * @param {{
 *   roomId?: string,
 *   email?: string,
 *   browserName?: string,
 *   browserVersion?: string,
 *   userAgent?: string,
 *   deviceId?: string,
 *   urlToSign?: string,
 *   pathWithQuery?: string,
 *   msToken?: string
 * }} options
 * @returns {Promise<object>}
 */
async function generateSigningParameters(win, options = {}) {
  await waitForDomReady(win);
  const {
    roomId = null,
    email = null,
    browserName = "Electron",
    browserVersion = process.versions.electron,
    userAgent = win.webContents.getUserAgent(),
    deviceId = randomDeviceId(),
    urlToSign = null,
    pathWithQuery: explicitPath = null,
    msToken: msTokenOverride = null
  } = options;

  const pathWithQuery = deriveSigningPath(win, roomId, urlToSign, explicitPath);
  const msTokenFromSession = typeof msTokenOverride === "string" && msTokenOverride.trim()
    ? msTokenOverride.trim()
    : await readMsTokenFromSession(win);

  const payloadScript = `
    (() => {
      try {
        if (!window.byted_acrawler || typeof window.byted_acrawler.sign !== "function") {
          throw new Error("byted_acrawler.sign is not available in this page context.");
        }
        const ensureMsToken = () => {
          try {
            const match = document.cookie.match(/(?:^|;\\s*)msToken=([^;]+)/);
            return match ? decodeURIComponent(match[1]) : "";
          } catch (_) {
            return "";
          }
        };
        const deviceId = ${JSON.stringify(deviceId)};
        const roomId = ${JSON.stringify(roomId)};
        const userAgent = ${JSON.stringify(userAgent)};
        const browserName = ${JSON.stringify(browserName)};
        const browserVersion = ${JSON.stringify(browserVersion)};
        const providedPath = ${JSON.stringify(pathWithQuery)};
        const msTokenFallback = ${JSON.stringify(msTokenFromSession || "")};

        const activeUrl = new URL(window.location.href);
        if (roomId && providedPath && !/(?:^|[?&])room_id=/.test(providedPath)) {
          activeUrl.searchParams.set("room_id", roomId);
        }
        const pathWithQuery = providedPath || (activeUrl.pathname + activeUrl.search);

        const xbPayload = { url: pathWithQuery, user_agent: userAgent };
        const xBogus = window.byted_acrawler.sign(xbPayload);

        let xGnarly = "";
        if (typeof window.byted_acrawler.encrypt === "function") {
          try {
            const gnarlyResponse = window.byted_acrawler.encrypt({
              url: pathWithQuery,
              user_agent: userAgent
            });
            xGnarly =
              gnarlyResponse?.["X-GNARLY"] ||
              gnarlyResponse?.["X-Gnarly"] ||
              gnarlyResponse?.value ||
              "";
          } catch (err) {
            console.warn("Failed to compute X-Gnarly", err);
          }
        }

        return {
          __success: true,
          payload: {
            device_id: deviceId,
            room_id: roomId,
            "X-Bogus": xBogus,
            msToken: msTokenFallback || ensureMsToken(),
            "X-Gnarly": xGnarly,
            browserName,
            browserVersion,
            userAgent,
            pathWithQuery
          }
        };
      } catch (error) {
        const message = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
        return { __success: false, __error: message };
      }
    })();
  `;

  const result = await exec(win, payloadScript);
  if (!result || result.__success !== true) {
    const reason = result && result.__error ? result.__error : "Failed to execute TikTok signing script.";
    throw new Error(reason);
  }
  return result.payload;
}

module.exports = {
  injectCrawlerBundle,
  generateSigningParameters,
  randomDeviceId
};
