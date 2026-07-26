#!/usr/bin/env node

'use strict';

const assert = require('assert');
const path = require('path');

const { buildMcpLaunchConfig } = require('../../resources/mcp-launch-config');

const windows = buildMcpLaunchConfig({
	isPackaged: true,
	platform: 'win32',
	execPath: 'C:\\Program Files\\Social Stream Ninja\\socialstream.exe',
	controlUrl: 'http://127.0.0.1:18888',
});
assert.deepStrictEqual(windows.mcpServers['social-stream'], {
	command: 'C:\\Program Files\\Social Stream Ninja\\socialstream.exe',
	args: ['--ssapp-mcp'],
	env: { SSAPP_CONTROL_URL: 'http://127.0.0.1:18888' },
});

const windowsPortable = buildMcpLaunchConfig({
	isPackaged: true,
	platform: 'win32',
	execPath: 'C:\\Users\\Steve\\AppData\\Local\\Temp\\socialstream.exe',
	portableExecutablePath: 'D:\\Tools\\socialstreamninja-portable.exe',
});
assert.strictEqual(
	windowsPortable.mcpServers['social-stream'].command,
	'D:\\Tools\\socialstreamninja-portable.exe'
);

const appImage = buildMcpLaunchConfig({
	isPackaged: true,
	platform: 'linux',
	execPath: '/tmp/.mount_social/socialstreamninja',
	appImagePath: '/opt/socialstream/Social Stream Ninja.AppImage',
});
assert.strictEqual(
	appImage.mcpServers['social-stream'].command,
	path.resolve('/opt/socialstream/Social Stream Ninja.AppImage')
);
assert.deepStrictEqual(appImage.mcpServers['social-stream'].args, ['--ssapp-mcp', '--ozone-platform=headless']);

const source = buildMcpLaunchConfig({
	isPackaged: false,
	platform: 'linux',
	execPath: '/opt/ssn_app/node_modules/electron/dist/electron',
	appPath: '/opt/ssn_app',
});
assert.deepStrictEqual(source.mcpServers['social-stream'].args, [
	'/opt/ssn_app',
	'--ssapp-mcp',
	'--ozone-platform=headless',
]);

console.log('MCP launch configuration regression checks passed.');
