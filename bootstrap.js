'use strict';

const path = require('path');
const { spawn } = require('child_process');

/**
 * Run the stdio MCP adapter with Electron's bundled Node runtime.
 *
 * A normal Windows Electron process exposes stdin as already closed, even when its caller
 * supplied a pipe. The underlying standard handles are still inheritable, so a
 * ELECTRON_RUN_AS_NODE child can use them normally. This keeps the downloaded application
 * itself usable as the MCP command without requiring a separate Node installation.
 */
function launchMcpAdapter() {
	const adapterPath = path.join(__dirname, 'resources', 'ssapp-mcp.js');
	let settled = false;
	const child = spawn(process.execPath, [adapterPath], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: '1',
		},
		stdio: 'inherit',
		windowsHide: true,
	});

	const exit = (code) => {
		if (settled) return;
		settled = true;
		process.exit(Number.isInteger(code) ? code : 1);
	};

	child.once('error', error => {
		try {
			process.stderr.write(`[SSApp MCP] Failed to launch adapter: ${error.message || error}\n`);
		} catch (_) { }
		exit(1);
	});
	child.once('exit', code => exit(code));

	// Best-effort cleanup if Electron is asked to stop before the adapter sees stdin close.
	process.once('exit', () => {
		try {
			if (child.exitCode === null) child.kill();
		} catch (_) { }
	});
}

// This runs before main.js loads, so adapter mode does not acquire the single-instance lock
// or create application windows.
if (process.argv.includes('--ssapp-mcp')) {
	launchMcpAdapter();
} else {
	require('./main');
}
