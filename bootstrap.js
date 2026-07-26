'use strict';

// Keep the downloaded application itself usable as the MCP stdio command. This runs before
// main.js loads, so adapter mode does not acquire the single-instance lock or create windows.
if (process.argv.includes('--ssapp-mcp')) {
	require('./resources/ssapp-mcp');
} else {
	require('./main');
}
