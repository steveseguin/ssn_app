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
const path = require("node:path");

const DEFAULT_BUNDLE_PATH = path.join(__dirname, "berrrk.js"); // retained for compatibility, unused without injection
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

function isMainFrameLoading(wc) {
  if (!wc) {
    return false;
  }
  if (typeof wc.isLoadingMainFrame === "function") {
    return wc.isLoadingMainFrame();
  }
  if (typeof wc.isLoading === "function") {
    return wc.isLoading();
  }
  return false;
}

async function waitForDomReady(win, timeout = PAGE_LOAD_TIMEOUT_MS) {
  const wc = getWebContents(win);
  if (!wc) {
    throw new Error("BrowserWindow webContents unavailable or already destroyed.");
  }

  const loading =
    isMainFrameLoading(wc) ||
    (!wc.isLoadingMainFrame && typeof wc.isLoading === "function" && wc.isLoading());
  if (!loading) {
    return;
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    const currentUrl = typeof wc.getURL === "function" ? wc.getURL() : "";
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        wc.removeListener("did-finish-load", onFinish);
        wc.removeListener("did-fail-load", onFail);
        wc.removeListener("destroyed", onDestroyed);
      } catch (_) { }
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

    const timer = setTimeout(async () => {
      if (settled) {
        return;
      }
      let readyState = null;
      try {
        readyState = await wc.executeJavaScript("document.readyState", true);
      } catch (_) { }
      if (readyState === "interactive" || readyState === "complete") {
        cleanup();
        resolve();
        return;
      }
      cleanup();
      const urlMeta = currentUrl ? ` for ${currentUrl}` : "";
      reject(new Error(`Timed out waiting for the TikTok window to finish loading${urlMeta}.`));
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
async function injectCrawlerBundle(win) {
  await waitForDomReady(win);
  const status = await exec(
    win,
    `
      (() => {
        const crawler = window.byted_acrawler;
        const hasCrawler = Boolean(crawler);
        const hasSign = Boolean(crawler && typeof crawler.sign === "function");
        const hasFrontierSign = Boolean(crawler && typeof crawler.frontierSign === "function");
        return {
          hasCrawler,
          hasSign,
          hasFrontierSign,
          ready: hasCrawler && (hasSign || hasFrontierSign)
        };
      })();
    `
  );
  if (!status || !status.ready) {
    throw new Error(
      "TikTok did not expose window.byted_acrawler in this page. Open a live room before generating signing keys."
    );
  }
  return status;
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

async function readSessionIdFromSession(win) {
  try {
    const electronSession = win && win.webContents ? win.webContents.session : null;
    if (!electronSession || !electronSession.cookies) {
      return "";
    }
    const cookies = await electronSession.cookies.get({
      url: "https://www.tiktok.com/",
      name: "sessionid"
    });
    if (!cookies || !cookies.length) {
      return "";
    }
    const cookie = cookies.find((entry) => entry && entry.name === "sessionid");
    if (!cookie || !cookie.value) {
      return "";
    }
    return decodeURIComponent(cookie.value);
  } catch (error) {
    console.warn("[tiktok-signing] Failed to read sessionid from Electron session:", error);
    return "";
  }
}

function buildWebcastFetchParams({
  roomId,
  deviceId,
  userAgent,
  browserName,
  browserVersion,
  msToken,
  email
}) {
  const base = {
    aid: "1988",
    app_language: "en",
    app_name: "tiktok_web",
    browser_language: "en-US",
    browser_name: browserName || "Electron",
    browser_online: "true",
    browser_version: browserVersion || "1.0.0",
    cookie_enabled: "true",
    cursor: "",
    debug: "false",
    device_id: deviceId,
    device_platform: "web",
    did_rule: "3",
    fetch_rule: "1",
    history_comment_count: "0",
    identity: "audience",
    internal_ext: "",
    live_id: "12",
    notice: email || "SSAPP_SIGN_HELPER",
    resp_content_type: "protobuf",
    room_id: roomId || "",
    screen_height: "1080",
    screen_width: "1920",
    tz_name: "UTC",
    version_code: "331310",
    msToken: msToken || "",
    platform: "pc",
    referer: "",
    user_agent: userAgent || ""
  };
  if (email) {
    base.contact_us = email;
  }
  return base;
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
    msToken: msTokenOverride = null,
    activeUrl: activeUrlOverride = null,
    performFetch = false
  } = options;

  const pathWithQuery = deriveSigningPath(win, roomId, urlToSign, explicitPath);
  const msTokenFromSession = typeof msTokenOverride === "string" && msTokenOverride.trim()
    ? msTokenOverride.trim()
    : await readMsTokenFromSession(win);
  const fetchParams = buildWebcastFetchParams({
    roomId,
    deviceId,
    userAgent,
    browserName,
    browserVersion,
    msToken: msTokenFromSession,
    email
  });
  const activeUrl =
    typeof activeUrlOverride === "string" && activeUrlOverride.trim()
      ? activeUrlOverride.trim()
      : (() => {
        try {
          const current = win && win.webContents && typeof win.webContents.getURL === "function"
            ? win.webContents.getURL()
            : "";
          return typeof current === "string" && current ? current : "https://www.tiktok.com/";
        } catch (error) {
          return "https://www.tiktok.com/";
        }
      })();

  async function tryFetchFromWebcast() {
    if (!roomId) {
      return null;
    }
    const fetchScript = `
      (() => {
        const requestConfig = ${JSON.stringify({
      url: "https://webcast.tiktok.com/webcast/im/fetch/",
      referer: activeUrl,
      params: fetchParams,
      includeBody: Boolean(performFetch)
    })};
        try {
          const requestUrl = new URL(requestConfig.url);
          const search = new URLSearchParams(requestConfig.params || {});
          requestUrl.search = search.toString();
          return fetch(requestUrl.toString(), {
            method: "GET",
            credentials: "include",
            headers: {
              "Referer": requestConfig.referer || window.location.href
            }
          }).then(async (response) => {
            const summary = {
              ok: Boolean(response && response.ok),
              status: response ? response.status : null,
              statusText: response ? response.statusText : null,
              url: response && response.url ? response.url : requestUrl.toString()
            };
            try {
              if (response && typeof response.headers?.forEach === "function") {
                const headers = {};
                response.headers.forEach((value, key) => {
                  headers[key] = value;
                });
                summary.headers = headers;
              }
            } catch (_) {
              summary.headers = null;
            }
            if (response && requestConfig.includeBody && response.ok) {
              try {
                const buf = await response.arrayBuffer();
                let binary = "";
                const bytes = new Uint8Array(buf);
                for (let i = 0; i < bytes.byteLength; i++) {
                  binary += String.fromCharCode(bytes[i]);
                }
                summary.bodyBase64 = window.btoa(binary);
              } catch (bodyError) {
                summary.bodyError =
                  bodyError && (bodyError.stack || bodyError.message)
                    ? bodyError.stack || bodyError.message
                    : String(bodyError);
              }
            }
            return summary;
          }).catch((error) => ({
            ok: false,
            status: null,
            statusText: null,
            error: error && (error.stack || error.message) ? (error.stack || error.message) : String(error),
            url: requestUrl.toString()
          }));
        } catch (fetchError) {
          return {
            ok: false,
            status: null,
            statusText: null,
            error: fetchError && (fetchError.stack || fetchError.message) ? (fetchError.stack || fetchError.message) : String(fetchError),
            url: ""
          };
        }
      })();
    `;
    const fetchResult = await exec(win, fetchScript);
    if (!fetchResult || !fetchResult.ok || !fetchResult.url) {
      return null;
    }
    let parsedUrl = null;
    try {
      parsedUrl = new URL(fetchResult.url);
    } catch (_) {
      parsedUrl = null;
    }
    if (!parsedUrl) {
      return null;
    }
    const searchParams = parsedUrl.searchParams;
    const xBogus =
      searchParams.get("X-Bogus") ||
      searchParams.get("X_Bogus") ||
      searchParams.get("x-bogus") ||
      "";
    const xGnarly =
      searchParams.get("X-Gnarly") ||
      searchParams.get("X_Gnarly") ||
      searchParams.get("x-gnarly") ||
      "";
    const signature =
      searchParams.get("_signature") ||
      searchParams.get("signature") ||
      searchParams.get("X-Signature") ||
      "";
    const finalMsToken =
      searchParams.get("msToken") ||
      searchParams.get("ms_token") ||
      msTokenFromSession ||
      "";
    const finalDeviceId = searchParams.get("device_id") || deviceId;
    const normalizedPath = parsedUrl.pathname + parsedUrl.search;
    const payload = {
      device_id: finalDeviceId,
      msToken: finalMsToken,
      "X-Bogus": xBogus,
      "X-Gnarly": xGnarly,
      _signature: signature,
      browserName,
      browserVersion,
      userAgent,
      pathWithQuery: normalizedPath,
      room_id: searchParams.get("room_id") || roomId,
      cursor: searchParams.get("cursor") || "",
      notice: searchParams.get("notice") || fetchParams.notice
    };
    const fetchResultPayload =
      fetchResult && fetchResult.bodyBase64
        ? {
            status: fetchResult.status || null,
            statusText: fetchResult.statusText || null,
            headers: fetchResult.headers || null,
            bodyBase64: fetchResult.bodyBase64
          }
        : null;
    if (fetchResultPayload) {
      payload.fetchResult = fetchResultPayload;
    } else if (fetchResult && fetchResult.bodyError) {
      payload.fetchError = fetchResult.bodyError;
    }
    return {
      payload,
      meta: {
        status: fetchResult.status || null,
        statusText: fetchResult.statusText || null
      }
    };
  }

  const fetchedResult = await tryFetchFromWebcast().catch(() => null);
  const fallbackPayload = fetchedResult && fetchedResult.payload ? fetchedResult.payload : null;
  if (fallbackPayload && !performFetch) {
    return fallbackPayload;
  }

  const payloadScript = `
    (() => {
      try {
        const crawler = window.byted_acrawler;
        if (!crawler) {
          throw new Error("byted_acrawler is not available in this page context.");
        }
        const ensureMsToken = () => {
          try {
            const match = document.cookie.match(/(?:^|;\\s*)msToken=([^;]+)/);
            return match ? decodeURIComponent(match[1]) : "";
          } catch (_) {
            return "";
          }
        };
        const hasLegacySign = typeof crawler.sign === "function";
        const hasFrontierSign = typeof crawler.frontierSign === "function";
        if (!hasLegacySign && !hasFrontierSign) {
          throw new Error("Neither byted_acrawler.sign nor byted_acrawler.frontierSign is available.");
        }
        const deviceId = ${JSON.stringify(deviceId)};
        const roomId = ${JSON.stringify(roomId)};
        const userAgent = ${JSON.stringify(userAgent)};
        const browserName = ${JSON.stringify(browserName)};
        const browserVersion = ${JSON.stringify(browserVersion)};
        const providedPath = ${JSON.stringify(pathWithQuery)};
        const msTokenFallback = ${JSON.stringify(msTokenFromSession || "")};
        const performFetch = ${JSON.stringify(options.performFetch || false)};

        const activeUrl = new URL(window.location.href);
        
        // Attempt to scrape roomId from SIGI_STATE if not provided
        let scrapedRoomId = null;
        if (!roomId) {
            try {
                if (window.SIGI_STATE) {
                    // Common paths for roomId in SIGI_STATE
                    scrapedRoomId = window.SIGI_STATE.liveRoom?.liveRoomUserInfo?.liveRoom?.roomId ||
                                    window.SIGI_STATE.appContext?.state?.room?.roomId ||
                                    window.SIGI_STATE.room?.roomId;
                }
            } catch (_) {
                // Ignore scraping errors
            }
        }
        const finalRoomId = roomId || scrapedRoomId;

        if (finalRoomId && providedPath && !/(?:^|[?&])room_id=/.test(providedPath)) {
          activeUrl.searchParams.set("room_id", finalRoomId);
        }
        const pathWithQuery = providedPath || (activeUrl.pathname + activeUrl.search);

        let xBogus = "";
        let xGnarly = "";
        if (hasLegacySign) {
          const legacyPayload = { url: pathWithQuery, user_agent: userAgent };
          xBogus = crawler.sign(legacyPayload);
          if (typeof crawler.encrypt === "function") {
            try {
              const gnarlyResponse = crawler.encrypt({
                url: pathWithQuery,
                user_agent: userAgent
              }) || {};
              xGnarly =
                gnarlyResponse["X-GNARLY"] ||
                gnarlyResponse["X-Gnarly"] ||
                gnarlyResponse["value"] ||
                gnarlyResponse["x-gnarly"] ||
                "";
            } catch (err) {
              console.warn("Failed to compute X-Gnarly via encrypt", err);
            }
          }
        } else if (hasFrontierSign) {
          const query = pathWithQuery.includes("?") ? pathWithQuery.split("?").slice(1).join("?") : "";
          let frontierResult = {};
          try {
            frontierResult =
              crawler.frontierSign({
                url: pathWithQuery,
                path: pathWithQuery,
                query,
                user_agent: userAgent,
                method: "GET",
                headers: {}
              }) || {};
          } catch (frontierError) {
            throw new Error(
              "byted_acrawler.frontierSign failed: " +
                (frontierError && frontierError.stack ? frontierError.stack : String(frontierError))
            );
          }
          const frontierHeaders =
            (frontierResult && typeof frontierResult === "object" && frontierResult.headers) || frontierResult || {};
          xBogus =
            frontierHeaders["X-Bogus"] ||
            frontierHeaders["x-bogus"] ||
            frontierHeaders["X_Bogus"] ||
            frontierHeaders["xbogus"] ||
            "";
          xGnarly =
            frontierHeaders["X-Gnarly"] ||
            frontierHeaders["X-GNARLY"] ||
            frontierHeaders["x-gnarly"] ||
            frontierHeaders["X_Gnarly"] ||
            frontierHeaders["x_gnarly"] ||
            "";
        }

        const basePayload = {
          __success: true,
          payload: {
            device_id: deviceId,
            room_id: finalRoomId,
            "X-Bogus": xBogus,
            msToken: msTokenFallback || ensureMsToken(),
            "X-Gnarly": xGnarly,
            browserName,
            browserVersion,
            userAgent,
            pathWithQuery
          }
        };
        if (typeof window === "object" && window.location) {
          basePayload.payload._signature = "";
        }

        return basePayload;
      } catch (error) {
        const message = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
        return { __success: false, __error: message };
      }
    })();
  `;

  const result = await exec(win, payloadScript);
  if (!result || result.__success !== true) {
    if (fallbackPayload) {
      return fallbackPayload;
    }
    const reason = result && result.__error ? result.__error : "Failed to execute TikTok signing script.";
    throw new Error(reason);
  }
  const resultPayload = result.payload || {};
  return fallbackPayload ? { ...fallbackPayload, ...resultPayload } : resultPayload;
}

module.exports = {
  injectCrawlerBundle,
  generateSigningParameters,
  randomDeviceId,
  readSessionIdFromSession
};
