"use strict";
const { performance } = require("perf_hooks");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const http = require("http");
const normalize = (value) =>
  String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[.,!?;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
module.exports = function installVoiceControl({
  app,
  BrowserWindow,
  ipcMain,
  isControl,
  isBackground,
  isSpeechPage,
  transcribe,
  cancelTranscription = () => {},
  sourceRoot,
}) {
  let deviceReply = null,
    uiBase = "",
    assets = null,
    capture = null,
    controllerFrame = null,
    commands = [],
    epoch = 0,
    sequence = 0,
    stopRevision = 0,
    playbackRevision = 0,
    armRevision = 0,
    busy = false,
    seen = new Map(),
    cooldowns = new Map(),
    playback = new Map(),
    server = null,
    token = "",
    port = 0,
    serial = Promise.resolve();
  let state = {
    phase: "stopped",
    armed: false,
    level: 0,
    heard: "",
    match: "",
    message: "Choose your microphone and start in Test mode.",
    commands: 0,
  };
  const snapshot = () => ({ ...state, commands: commands.length });
  const suppress = () =>
    Array.from(playback.values()).some((until) => until > performance.now());
  function disarm() {
    state.armed = false;
    epoch++;
    state.level = 0;
    state.heard = "";
    state.match = "";
    seen.clear();
    cooldowns.clear();
  }
  async function stop() {
    stopRevision++;
    disarm();
    state.phase = "stopped";
    state.message = "Listening stopped.";
    cancelTranscription();
    // A crashed renderer can lose its frame before Electron destroys the window.
    try {
      if (capture && !capture.isDestroyed())
        capture.webContents.send("voice:capture-control", { stop: true });
    } catch (_) {
      if (capture && !capture.isDestroyed()) capture.destroy();
    }
  }
  function stopFailedCapture(win) {
    if (capture !== win) return;
    stop();
    state.message = "Microphone service stopped. Restart listening.";
    if (!win.isDestroyed()) win.destroy();
  }
  function checkCaptureHealth() {
    // Electron can mark a renderer crashed before emitting render-process-gone.
    if (capture && (capture.isDestroyed() || capture.webContents.isCrashed()))
      stopFailedCapture(capture);
  }
  async function ensureCapture() {
    if (capture && !capture.isDestroyed()) return capture;
    capture = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "voice-capture-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: false,
        partition: "voice-capture-private",
      },
    });
    capture.webContents.session.setPermissionRequestHandler(
      (wc, permission, callback, details) =>
        callback(
          wc === capture.webContents &&
            permission === "media" &&
            !(details.mediaTypes || []).includes("video"),
        ),
    );
    capture.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    capture.webContents.on("will-navigate", (e) => e.preventDefault());
    const win = capture;
    capture.webContents.on("render-process-gone", () => stopFailedCapture(win));
    capture.on("closed", () => {
      capture = null;
      disarm();
      state.phase = "stopped";
    });
    await capture.loadFile(path.join(__dirname, "voice-capture.html"));
    return capture;
  }
  async function control(action, options = {}) {
    checkCaptureHealth();
    if (!options || typeof options !== "object" || Array.isArray(options))
      options = {};
    if (action === "status") return snapshot();
    if (action === "devices") {
      if (state.phase !== "stopped")
        throw Error("Stop listening before choosing a microphone.");
      const win = await ensureCapture();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          deviceReply = null;
          reject(Error("Microphone permission was not granted."));
        }, 15000);
        deviceReply = (devices) => {
          clearTimeout(timer);
          deviceReply = null;
          resolve({ ...snapshot(), devices });
        };
        win.webContents.send("voice:capture-control", { devices: true });
      });
    }
    if (action === "stop") {
      await stop();
      return snapshot();
    }
    if (action === "arm") {
      if (state.phase !== "listening")
        throw Error("Wait until the microphone is ready.");
      if (!controllerFrame || controllerFrame.detached)
        throw Error("Open Event Flow in SSApp before arming.");
      armRevision++;
      state.armed = options.armed === true;
      state.message = state.armed
        ? "Armed - matching phrases run Event Flows."
        : "Test mode - actions will not run.";
      return snapshot();
    }
    if (action === "start") {
      if (state.phase !== "stopped")
        throw Error("Stop listening before changing microphone.");
      if (busy)
        throw Error(
          "Speech service is still finishing a request. Try again shortly.",
        );
      await stop();
      const run = epoch;
      state.phase = "loading";
      state.message =
        "Preparing local English Whisper. First use downloads its verified runtime and model.";
      const win = await ensureCapture();
      try {
        busy = true;
        await transcribe(win.webContents, new Float32Array(8000).buffer);
        if (run !== epoch) return snapshot();
        state.phase = "starting";
        state.message = "Opening microphone...";
        win.webContents.send("voice:capture-control", {
          epoch: run,
          deviceId:
            typeof options.deviceId === "string"
              ? options.deviceId.slice(0, 256)
              : "",
        });
      } catch (e) {
        if (run === epoch) {
          await stop();
          state.message = String(e.message || e);
        }
      } finally {
        busy = false;
      }
      return snapshot();
    }
    if (action === "dock") {
      await ensureServer();
      return {
        ...snapshot(),
        dockUrl: "http://127.0.0.1:" + port + "/#" + token,
      };
    }
    if (action === "revoke") {
      token = crypto.randomBytes(32).toString("hex");
      return snapshot();
    }
    throw Error("Unknown voice control operation.");
  }
  // Stop also invalidates control requests already waiting behind another operation.
  function dispatchControl(action, options) {
    if (action === "stop") return control(action, options);
    if (action === "status") return control(action, options);
    const revision = stopRevision;
    const next = serial.then(() => {
      if (revision !== stopRevision && (action === "start" || action === "arm"))
        throw Error("Cancelled by Stop.");
      return control(action, options);
    });
    serial = next.catch(() => {});
    return next;
  }
  ipcMain.handle("voice:control", (event, action, options) => {
    if (!isControl(event))
      throw Error("Voice controls require the trusted Voice Control page.");
    uiBase = event.senderFrame.url;
    return dispatchControl(action, options);
  });
  ipcMain.handle("voice:sync", (event, items) => {
    if (!isBackground(event))
      throw Error("Only Event Flow may register voice commands.");
    checkCaptureHealth();
    controllerFrame = event.senderFrame;
    const list = Array.isArray(items) ? items.slice(0, 200) : [];
    commands = list
      .filter(
        (c) =>
          c &&
          typeof c.flowId === "string" &&
          typeof c.nodeId === "string" &&
          typeof c.phrase === "string",
      )
      .map((c) => ({
        flowId: c.flowId.slice(0, 128),
        nodeId: c.nodeId.slice(0, 128),
        phrase: normalize(c.phrase).slice(0, 160),
        cooldown: Math.max(1, Math.min(300, Number(c.cooldown) || 5)) * 1000,
      }))
      .filter((c) => c.phrase.length >= 3);
    return snapshot();
  });
  ipcMain.handle("voice:playback", (event, active) => {
    if (!isSpeechPage(event)) return false;
    const key = event.sender.id + ":" + event.senderFrame.routingId;
    playbackRevision++;
    playback.set(key, performance.now() + (active ? 2000 : 600));
    if (capture && !capture.isDestroyed())
      capture.webContents.send("voice:capture-control", {
        suppressMs: Math.max(0, ...playback.values()) - performance.now(),
      });
    if (playback.size > 100)
      for (const [k, t] of playback)
        if (t < performance.now()) playback.delete(k);
    return true;
  });
  ipcMain.handle("voice:capture", async (event, kind, data) => {
    if (
      !capture ||
      event.sender !== capture.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw Error("Private microphone service only.");
    if (kind === "devices") {
      if (deviceReply) deviceReply(Array.isArray(data) ? data : []);
      return;
    }
    if (!data || data.epoch !== epoch) return;
    if (kind === "ready") {
      state.phase = "listening";
      state.message = "Test mode - say a configured phrase.";
      return;
    }
    if (kind === "error") {
      await stop();
      state.message = String(data.error || "Microphone failed.").slice(0, 200);
      return;
    }
    if (kind === "long-speech") {
      state.match = "";
      state.message = "Long speech ignored. Say a short phrase, then pause.";
      return;
    }
    if (kind === "meter") {
      state.level = Math.max(0, Math.min(1, Number(data.level) || 0));
      return;
    }
    if (kind !== "audio" || state.phase !== "listening" || busy || suppress())
      return;
    if (
      !(data.audio instanceof ArrayBuffer) ||
      data.audio.byteLength < 12800 ||
      data.audio.byteLength > 320000
    )
      return;
    const run = epoch,
      id = ++sequence,
      ended =
        performance.now() -
        Math.min(1000, Math.max(0, Number(data.trailingMs) || 0)),
      wasArmed = state.armed,
      speechRevision = playbackRevision,
      armedRevision = armRevision;
    busy = true;
    try {
      const result = await transcribe(event.sender, data.audio);
      checkCaptureHealth();
      if (run !== epoch || state.phase !== "listening") return;
      const text = String(result.text || "")
        .trim()
        .slice(0, 500);
      state.heard = text;
      state.match = "";
      if (performance.now() - ended > 2000) {
        state.message = "Recognition was too slow. Command skipped.";
        return;
      }
      if (suppress() || speechRevision !== playbackRevision) return;
      const found = commands.filter((c) => c.phrase === normalize(text));
      state.match = found.length ? found.map((c) => c.phrase).join(", ") : "";
      state.message = found.length
        ? state.armed
          ? "Phrase matched."
          : "Would match - Test mode only."
        : "Listening - no matching phrase.";
      if (!wasArmed || !state.armed || armedRevision !== armRevision) return;
      for (const c of found) {
        const key = JSON.stringify([c.flowId, c.nodeId]),
          now = performance.now();
        if (
          now - (cooldowns.get(key) || -Infinity) < c.cooldown ||
          seen.has(key + ":" + id)
        )
          continue;
        if (!controllerFrame || controllerFrame.detached) {
          await stop();
          state.message = "Event Flow disconnected. Reopen it and start again.";
          return;
        }
        cooldowns.set(key, now);
        seen.set(key + ":" + id, now);
        if (seen.size > 1000) seen.delete(seen.keys().next().value);
        controllerFrame.send("voice:command", {
          flowId: c.flowId,
          nodeId: c.nodeId,
          text,
          id,
          epoch,
          expiresAt:
            Date.now() + Math.max(0, 2000 - (performance.now() - ended)),
        });
      }
    } catch (e) {
      if (run === epoch) {
        state.armed = false;
        state.message =
          "Recognition failed. Stopped arming; try again in Test mode.";
      }
    } finally {
      busy = false;
    }
  });
  async function ensureServer() {
    if (server) return;
    const root = sourceRoot();
    assets = {};
    for (const file of [
      "voice-control.html",
      "voice-control.js",
      "voice-control.css",
    ]) {
      if (root && fs.existsSync(path.join(root, file)))
        assets[file] = fs.readFileSync(path.join(root, file));
      else {
        if (!/^https:\/\//.test(uiBase))
          throw Error("Open the current Voice Control page in SSApp first.");
        const response = await fetch(new URL(file, uiBase), {
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (!response.ok) throw Error("Could not load OBS dock files.");
        assets[file] = Buffer.from(await response.arrayBuffer());
      }
    }
    token = crypto.randomBytes(32).toString("hex");
    server = http.createServer((req, res) => {
      const expected = "127.0.0.1:" + port;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (
        req.headers.host !== expected ||
        (req.headers.origin && req.headers.origin !== "http://" + expected)
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      const pathname = String(req.url || "").split("?")[0];
      if (
        req.method === "GET" &&
        ["/", "/voice-control.js", "/voice-control.css"].includes(pathname)
      ) {
        const file =
          pathname === "/" ? "voice-control.html" : pathname.slice(1);
        res.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
        res.end(assets[file]);
        return;
      }
      if (
        req.method !== "POST" ||
        pathname !== "/control" ||
        req.headers["x-ssn-voice"] !== token
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      req.on("end", () => {
        let data;
        try {
          data = JSON.parse(body);
          if (!data || typeof data !== "object" || Array.isArray(data))
            throw Error("Invalid request");
        } catch (_) {
          res.writeHead(400);
          res.end();
          return;
        }
        if (
          !["status", "start", "stop", "arm", "devices"].includes(data.action)
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        const next = dispatchControl(data.action, data.options);
        next.then(
          (s) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(s));
          },
          (e) => {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          },
        );
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  }
  app.on("before-quit", () => {
    stop();
    if (server) server.close();
  });
  return { stop };
};
module.exports.normalize = normalize;
