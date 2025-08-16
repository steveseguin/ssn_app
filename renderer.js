// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// No Node.js APIs are available in this process because
// `nodeIntegration` is turned off. Use `preload.js` to
// selectively enable features needed in the rendering
// process.

// Performance monitor temporarily disabled to fix loading issues
// Will be re-enabled after testing
/*
if (typeof PerformanceMonitor !== 'undefined') {
    // If loaded via script tag
    const perfMonitor = new PerformanceMonitor();
    perfMonitor.init();
} else {
    // Try to load via require if available
    try {
        const PerformanceMonitor = require('./performance-monitor.js');
        const perfMonitor = new PerformanceMonitor();
        perfMonitor.init();
    } catch (e) {
        // Performance monitor not available
        console.log('Performance monitor not available');
    }
}
*/

unhandled();
