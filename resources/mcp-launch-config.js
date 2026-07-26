'use strict';

const path = require('path');

const DEFAULT_CONTROL_URL = 'http://127.0.0.1:17777';

/**
 * Build a common MCP client configuration using the application that is currently running.
 * Packaged Linux AppImages expose their original path through APPIMAGE; process.execPath is
 * only the temporary mount path and would stop working after the app exits.
 * @param {object} options - Runtime paths and application state.
 * @returns {object} A common `mcpServers` JSON configuration.
 */
function buildMcpLaunchConfig(options = {}) {
	const isPackaged = options.isPackaged === true;
	const platform = String(options.platform || process.platform);
	const execPath = String(options.execPath || '').trim();
	const appPath = String(options.appPath || '').trim();
	const appImagePath = String(options.appImagePath || '').trim();
	const portableExecutablePath = String(options.portableExecutablePath || '').trim();
	const controlUrl = String(options.controlUrl || DEFAULT_CONTROL_URL).trim() || DEFAULT_CONTROL_URL;

	let command = execPath;
	if (isPackaged && platform === 'linux' && appImagePath) {
		command = path.resolve(appImagePath);
	} else if (isPackaged && platform === 'win32' && portableExecutablePath) {
		command = portableExecutablePath;
	}
	if (!command) throw new Error('The Social Stream Ninja executable path is unavailable.');
	if (!isPackaged && !appPath) throw new Error('The Social Stream Ninja application path is unavailable.');

	const args = isPackaged ? ['--ssapp-mcp'] : [appPath, '--ssapp-mcp'];
	if (platform === 'linux') args.push('--ozone-platform=headless');

	return {
		mcpServers: {
			'social-stream': {
				command,
				args,
				env: { SSAPP_CONTROL_URL: controlUrl },
			},
		},
	};
}

module.exports = {
	DEFAULT_CONTROL_URL,
	buildMcpLaunchConfig,
};
