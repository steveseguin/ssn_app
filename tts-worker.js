const { parentPort, workerData } = require('worker_threads');
const { KokoroTTS } = require("kokoro-js");
const os = require('os');
const process = require("process");
const path = require('path');

if (process.platform === 'win32') {
  try {
    // Set process priority to below normal
    process.resourceUsage = { priority: 'below_normal' };
  } catch (error) {
    console.error('Failed to set process priority:', error);
  }
}

const modelPath = (() => {
  const { appPath } = workerData;
  return appPath;
})();

// Function to convert to WAV format
function convertToWav(buffer, options) {
	const { sampleRate = 44100, channels = 1, bitDepth = 16 } = options;

	// WAV header size
	const headerSize = 44;
	const dataSize = buffer.length;
	const wavBuffer = Buffer.alloc(headerSize + dataSize);

	// Write WAV header
	// "RIFF" chunk descriptor
	wavBuffer.write('RIFF', 0);
	wavBuffer.writeUInt32LE(36 + dataSize, 4); // Chunk size
	wavBuffer.write('WAVE', 8);

	// "fmt " sub-chunk
	wavBuffer.write('fmt ', 12);
	wavBuffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
	wavBuffer.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
	wavBuffer.writeUInt16LE(channels, 22); // NumChannels
	wavBuffer.writeUInt32LE(sampleRate, 24); // SampleRate
	wavBuffer.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28); // ByteRate
	wavBuffer.writeUInt16LE(channels * (bitDepth / 8), 32); // BlockAlign
	wavBuffer.writeUInt16LE(bitDepth, 34); // BitsPerSample

	// "data" sub-chunk
	wavBuffer.write('data', 36);
	wavBuffer.writeUInt32LE(dataSize, 40); // Subchunk2Size

	// Copy the PCM data
	buffer.copy(wavBuffer, headerSize);

	return wavBuffer;
}

parentPort.on('message', async (data) => {
  try {
    
	//const modelPath = "C:\\Users\\steve\\AppData\\Local\\Programs\\SocialStream\\resources\\app.asar.unpacked\\node_modules\\@huggingface\\transformers\\.cache\\onnx-community\\Kokoro-82M-ONNX";
	
    const tts = await KokoroTTS.from_pretrained(
      modelPath,
      { 
        dtype: "q8",
        execution_provider: ["dml", "cuda", "cpu"]
      }
    );
    
    const audio = await tts.generate(data.text, { voice: (data?.settings?.voice || data?.settings?.voiceName || "af_aoede"), speed: (data?.settings?.speed || data?.settings?.rate || 1.0) });
    const audioData = audio.audio;
    
    // Convert Float32Array to Int16Array for WAV format
    const int16Data = new Int16Array(audioData.length);
    
    for (let i = 0; i < audioData.length; i++) {
      int16Data[i] = Math.min(1, Math.max(-1, audioData[i])) * 32767;
    }
    
    // Create a buffer from the Int16Array
    const rawBuffer = Buffer.from(int16Data.buffer);
    
    // Convert to WAV format
    const wavBuffer = convertToWav(rawBuffer, {
      sampleRate: audio.sampling_rate,
      channels: 1,
      bitDepth: 16
    });
    
    // Send the result back to the main thread
    parentPort.postMessage({ wavBuffer });
  } catch (error) {
    console.error("TTS Error in worker:", error);
    parentPort.postMessage({ error: error.message });
  }
});