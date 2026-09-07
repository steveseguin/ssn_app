"use strict";

// Optional Windows command runtime. Models/binaries are pinned downloads, never page-supplied code.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");
const manifest = require("./voice-native-manifest.json");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

module.exports = function createNativeWhisper({ app }) {
  const supported = process.platform === "win32" && process.arch === "x64";
  const cpuCount = os.cpus().length;
  // Extra threads help on high-core desktops. Preserve the existing limit on smaller PCs.
  const threadCount = cpuCount >= 24 ? 6 : Math.max(1, Math.min(4, cpuCount));
  const directory =
    process.env.SSAPP_NATIVE_WHISPER_CACHE_DIR ||
    path.join(
      app.getPath("userData"),
      "models",
      "voice-" + manifest.runtimeVersion,
    );
  let preparation = null,
    download = null,
    child = null,
    generation = 0;

  async function valid(file, expected) {
    try {
      return (
        sha256(await fs.promises.readFile(path.join(directory, file))) ===
        expected
      );
    } catch (_) {
      return false;
    }
  }

  async function fetchPinned(url, expected, limit, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw Error(
        "Voice download failed (" + response.status + "). Try Start again.",
      );
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw Error("Voice download exceeded its size limit.");
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);
    if (sha256(data) !== expected)
      throw Error("Voice download failed its integrity check.");
    return data;
  }

  async function save(file, data) {
    // Only fixed names from the pinned manifest reach this path; no archive paths are extracted.
    const target = path.join(directory, file),
      temporary = target + ".partial";
    await fs.promises.writeFile(temporary, data);
    await fs.promises.rename(temporary, target);
  }

  async function prepare() {
    if (preparation) return preparation;
    preparation = (async () => {
      await fs.promises.mkdir(directory, { recursive: true });
      download = new AbortController();
      const timer = setTimeout(() => download && download.abort(), 180000);
      try {
        const files = Object.entries(manifest.files);
        const checks = await Promise.all(
          files.map(([file, hash]) => valid(file, hash)),
        );
        if (checks.some((ok) => !ok)) {
          const bytes = await fetchPinned(
            manifest.runtimeUrl,
            manifest.runtimeSha256,
            12000000,
            download.signal,
          );
          const archive = await require("unzipper").Open.buffer(bytes);
          for (const [file, hash] of files) {
            const entry = archive.files.find(
              (item) => item.path === "Release/" + file,
            );
            if (!entry || entry.uncompressedSize > 3000000)
              throw Error("Voice runtime archive is incomplete.");
            const data = await entry.buffer();
            if (sha256(data) !== hash)
              throw Error("Voice runtime file failed its integrity check.");
            await save(file, data);
          }
        }
        if (!(await valid("tiny.en-q5_1.bin", manifest.modelSha256))) {
          await save(
            "tiny.en-q5_1.bin",
            await fetchPinned(
              manifest.modelUrl,
              manifest.modelSha256,
              40000000,
              download.signal,
            ),
          );
        }
      } finally {
        clearTimeout(timer);
        download = null;
      }
    })().catch((error) => {
      preparation = null;
      throw error;
    });
    return preparation;
  }

  function stop() {
    generation++;
    if (download) download.abort();
    if (child) child.kill();
  }

  function wav(audio) {
    const samples = new Float32Array(audio),
      data = Buffer.alloc(44 + samples.length * 2);
    data.write("RIFF");
    data.writeUInt32LE(data.length - 8, 4);
    data.write("WAVEfmt ", 8);
    data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20);
    data.writeUInt16LE(1, 22);
    data.writeUInt32LE(16000, 24);
    data.writeUInt32LE(32000, 28);
    data.writeUInt16LE(2, 32);
    data.writeUInt16LE(16, 34);
    data.write("data", 36);
    data.writeUInt32LE(data.length - 44, 40);
    for (let i = 0; i < samples.length; i++)
      data.writeInt16LE(
        Math.round(
          Math.max(
            -1,
            Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0),
          ) * 32767,
        ),
        44 + i * 2,
      );
    return data;
  }

  async function transcribe(audio) {
    const run = generation;
    await prepare();
    if (run !== generation) throw Error("Voice recognition cancelled.");
    return new Promise((resolve, reject) => {
      const processHandle = spawn(
        path.join(directory, "whisper-cli.exe"),
        [
          "-m",
          path.join(directory, "tiny.en-q5_1.bin"),
          "-f",
          "-",
          "-of",
          "ssn-voice",
          "-nt",
          "-np",
          "-ng",
          "-bo",
          "1",
          "-bs",
          "1",
          "-nf",
          // A proper-name hint, not a list of commands that could bias unrelated speech.
          "--prompt",
          "Ninja.",
          "-t",
          String(threadCount),
        ],
        { cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      child = processHandle;
      let output = "",
        settled = false;
      const finish = (failure, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child === processHandle) child = null;
        failure ? reject(failure) : resolve(result);
      };
      const timer = setTimeout(() => {
        processHandle.kill();
        finish(Error("Local voice recognition timed out."));
      }, 5000);
      processHandle.on("error", (failure) => finish(failure));
      processHandle.stdout.on("data", (data) => {
        output += data.toString("utf8");
        if (output.length > 8192) {
          processHandle.kill();
          finish(Error("Voice response exceeded its size limit."));
        }
      });
      processHandle.stderr.resume();
      processHandle.stdin.on("error", () => {}); // Process exit/timeout supplies the useful error.
      processHandle.on("close", (code) => {
        if (run !== generation)
          return finish(Error("Voice recognition cancelled."));
        if (code >>> 0 === 0xc0000135)
          return finish(
            Error(
              "Local voice runtime is missing a Windows dependency. Install Microsoft Visual C++ Redistributable (x64), then restart listening.",
            ),
          );
        if (code !== 0)
          return finish(
            Error("Local voice runtime failed. Restart listening."),
          );
        finish(null, {
          text: output
            .replace(/\[(?:blank_audio|music|silence|inaudible)\]/gi, " ")
            .replace(/\s+/g, " ")
            .trim(),
        });
      });
      // No microphone recordings or transcripts are written to disk, and no local HTTP server is needed.
      processHandle.stdin.end(wav(audio));
    });
  }
  return { supported, transcribe, stop };
};
