//afterpack.js
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

exports.default = async function(artifacts, platformName) {
  // Get version from package.json directly
  const pkgJson = require('./package.json');
  const version = pkgJson.version;
  
  // The artifacts are already in the dist directory
  const distDir = path.join(__dirname, 'dist');
  
  console.log('Starting afterAllArtifactBuild process');
  console.log('Platform:', platformName);
  console.log('distDir:', distDir);
  
  // Handle Windows artifacts
  if (process.platform === 'win32') {
    const portableSource = path.join(distDir, 'socialstreamninja-portable.exe');
    const portableDest = path.join(distDir, `socialstreamninja_win_v${version}_portable.zip`);
    
    const installerSource = path.join(distDir, `socialstreamninja-setup-${version}.exe`);
    const installerDest = path.join(distDir, `socialstreamninja_win_v${version}_installer.zip`);
    
    const files = [
      {
        source: portableSource,
        dest: portableDest,
        type: 'portable'
      },
      {
        source: installerSource,
        dest: installerDest,
        type: 'installer'
      }
    ];
    
    for (const file of files) {
      console.log(`Looking for ${file.type} at:`, file.source);
      if (fs.existsSync(file.source)) {
        console.log(`Creating ${file.type} zip at:`, file.dest);
        try {
          await createZip(file.source, file.dest);
        } catch (err) {
          console.error(`Error zipping ${file.type}:`, err);
        }
      } else {
        console.error(`${file.type} not found at:`, file.source);
      }
    }
  }
  
  // Handle Mac artifacts - rename zip if it exists with old naming
  if (process.platform === 'darwin') {
    // Mac may produce zip with old naming scheme due to electron-builder behavior
    // Look for possible Mac zip files with old naming pattern
    const macDir = path.join(distDir, 'mac');
    const macFiles = fs.readdirSync(distDir);
    
    console.log('Checking Mac directory for files:', macFiles);
    
    // Look for any zip file that includes 'socialstream' and 'mac' in the name
    const oldStyleZip = macFiles.find(file => 
      file.includes('socialstream') && 
      file.includes('mac') && 
      file.endsWith('.zip')
    );
    
    if (oldStyleZip) {
      const oldPath = path.join(distDir, oldStyleZip);
      // Get architecture information (universal, arm64, x64)
      let arch = 'universal';
      if (oldStyleZip.includes('arm64')) {
        arch = 'arm64';
      } else if (oldStyleZip.includes('x64')) {
        arch = 'x64';
      }
      
      const newPath = path.join(distDir, `socialstreamninja_mac_v${version}_${arch}.zip`);
      
      console.log(`Renaming Mac zip from ${oldPath} to ${newPath}`);
      try {
        fs.renameSync(oldPath, newPath);
        console.log('Successfully renamed Mac zip file');
      } catch (err) {
        console.error('Error renaming Mac zip file:', err);
      }
    } else {
      console.log('No Mac zip file found to rename');
    }
  }
};

function createZip(source, dest) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(dest);
    const archive = archiver('zip', { zlib: { level: 9 }});
    
    output.on('close', () => {
      console.log(`Successfully created zip: ${dest}`);
      resolve();
    });
    
    archive.on('error', (err) => {
      console.error('Error creating zip:', err);
      reject(err);
    });
    
    archive.pipe(output);
    archive.file(source, { name: path.basename(source) });
    archive.finalize();
  });
}