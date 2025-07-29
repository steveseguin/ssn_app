const fs = require('fs');
const path = require('path');

exports.default = async function(configuration) {
    // Check if certificate exists
    const certPath = path.join(__dirname, 'certs', 'socialstream.pfx');
    if (!fs.existsSync(certPath)) {
        console.log('  • skipping signing  reason=certificate not found at certs/socialstream.pfx');
        return false; // Return false to skip signing
    }

    // Check if password is provided
    if (!process.env.WIN_CSC_KEY_PASSWORD) {
        console.log('  • skipping signing  reason=WIN_CSC_KEY_PASSWORD not set');
        return false; // Return false to skip signing
    }

    // If both exist, let electron-builder handle the signing
    console.log('  • certificate and password available, proceeding with signing');
    
    // Return true to let electron-builder use its default signing process
    return true;
};