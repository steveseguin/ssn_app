/* Private renderer: microphone capture only. No remote navigation or model code. */
(function () {
  "use strict";
  let stream,
    context,
    source,
    processor,
    silent,
    epoch = 0,
    suppressUntil = 0,
    chunks = [],
    count = 0,
    quiet = 0,
    speech = false,
    waitingForPause = false,
    noise = 0.003,
    pre = [];
  function clear() {
    chunks = [];
    count = 0;
    quiet = 0;
    speech = false;
    waitingForPause = false;
    pre = [];
  }
  async function stop() {
    epoch++;
    clear();
    if (processor) processor.disconnect();
    if (source) source.disconnect();
    if (silent) silent.disconnect();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (context) await context.close().catch(() => {});
    stream = context = source = processor = silent = null;
  }
  function resample(data, rate) {
    const out = new Float32Array(Math.round((data.length * 16000) / rate));
    for (let i = 0; i < out.length; i++) {
      const x = (i * rate) / 16000,
        j = Math.floor(x);
      out[i] =
        data[j] * (1 - (x - j)) +
        (data[Math.min(j + 1, data.length - 1)] || 0) * (x - j);
    }
    return out;
  }
  window.voiceCapture.onControl(async (command) => {
    if (Number.isFinite(command.suppressMs)) {
      suppressUntil = performance.now() + Math.max(0, command.suppressMs);
      clear();
      return;
    }
    if (command.devices) {
      try {
        const temp = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        temp.getTracks().forEach((t) => t.stop());
        const list = await navigator.mediaDevices.enumerateDevices();
        await window.voiceCapture.send(
          "devices",
          list
            .filter((d) => d.kind === "audioinput")
            .map((d) => ({ deviceId: d.deviceId, label: d.label })),
        );
      } catch (_) {
        await window.voiceCapture.send("devices", []);
      }
      return;
    }
    await stop();
    if (command.stop) return;
    const current = epoch;
    try {
      const incomingStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: command.deviceId ? { exact: command.deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (current !== epoch) {
        incomingStream.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = incomingStream;
      context = new AudioContext();
      await context.resume();
      if (current !== epoch) return;
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(2048, 1, 1);
      silent = context.createGain();
      silent.gain.value = 0;
      source.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      let meterAt = 0;
      stream.getAudioTracks()[0].onended = () => {
        window.voiceCapture.send("error", {
          epoch: command.epoch,
          error: "Microphone disconnected. Select it again.",
        });
        stop();
      };
      processor.onaudioprocess = (e) => {
        if (current !== epoch) return;
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length),
          rate = context.sampleRate,
          now = performance.now();
        if (now - meterAt > 250) {
          meterAt = now;
          window.voiceCapture
            .send("meter", {
              epoch: command.epoch,
              level: Math.min(1, rms * 8),
            })
            .catch(() => {});
        }
        if (now < suppressUntil) {
          clear();
          return;
        }
        const voiced = rms > Math.max(0.009, Math.min(0.04, noise * 3));
        if (waitingForPause) {
          quiet = voiced ? 0 : quiet + data.length;
          if (quiet > rate * 0.45) clear();
          return;
        }
        if (!speech) {
          if (!voiced) {
            noise = noise * 0.98 + rms * 0.02;
            pre.push(data);
            if (pre.length > Math.ceil((rate * 0.25) / 2048)) pre.shift();
            return;
          }
          speech = true;
          chunks = pre;
          count = chunks.reduce((n, c) => n + c.length, 0);
          pre = [];
        }
        chunks.push(data);
        count += data.length;
        quiet = voiced ? 0 : quiet + data.length;
        if (count > rate * 4 && quiet <= rate * 0.45) {
          clear();
          waitingForPause = true;
          window.voiceCapture
            .send("long-speech", { epoch: command.epoch })
            .catch(() => {});
          return;
        }
        if (quiet > rate * 0.45) {
          const trailing = quiet,
            joined = new Float32Array(count);
          let offset = 0;
          chunks.forEach((c) => {
            joined.set(c, offset);
            offset += c.length;
          });
          const voicedLength = count - trailing;
          clear();
          if (voicedLength < rate * 0.2) return;
          const pcm = resample(joined, rate);
          window.voiceCapture
            .send("audio", {
              epoch: command.epoch,
              audio: pcm.buffer,
              trailingMs: (trailing / rate) * 1000,
            })
            .catch(() => {});
        }
      };
      await window.voiceCapture.send("ready", { epoch: command.epoch });
    } catch (e) {
      if (current !== epoch) return;
      await window.voiceCapture.send("error", {
        epoch: command.epoch,
        error:
          e.name === "NotAllowedError"
            ? "Microphone permission denied."
            : String(e.message || e),
      });
      await stop();
    }
  });
})();
