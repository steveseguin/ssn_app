const { KokoroTTS } = require("kokoro-js");
const fs = require('fs');
const path = require('path');

// Create models directory in the project
const modelsDir = path.join(__dirname, 'models');

if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true });
}

// Set KOKORO_HOME to our local models directory
process.env.KOKORO_HOME = modelsDir;

async function downloadModel() {
  console.log('Downloading Kokoro TTS model to:', modelsDir);
  
  try {
    // This will trigger the model download
    await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-ONNX", 
      { 
        dtype: "q8",
        execution_provider: ["cpu"]
      }
    );
    
    console.log('Model download complete');
  } catch (error) {
    console.error('Failed to download model:', error);
    process.exit(1);
  }
}

downloadModel();