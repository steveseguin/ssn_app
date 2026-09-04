#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');

function getArgument(name) {
	const prefix = `--${name}=`;
	const inline = process.argv.find((value) => value.startsWith(prefix));
	if (inline) return inline.slice(prefix.length).trim();
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close((error) => error ? reject(error) : resolve(port));
		});
	});
}

function escapePowerShellLiteral(value) {
	return String(value || '').replace(/'/g, "''");
}

function getPrinterJobs(printerName) {
	const escapedName = escapePowerShellLiteral(printerName);
	const command = `@(
		Get-PrintJob -PrinterName '${escapedName}' -ErrorAction SilentlyContinue |
		Select-Object ID, DocumentName, JobStatus, PagesPrinted, TotalPages
	) | ConvertTo-Json -Compress`;
	const response = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
		encoding: 'utf8',
		windowsHide: true,
	});
	if (response.status !== 0) {
		throw new Error(`Unable to inspect the Windows print queue: ${response.stderr || response.stdout}`);
	}
	const output = String(response.stdout || '').trim();
	if (!output) return [];
	const parsed = JSON.parse(output);
	return Array.isArray(parsed) ? parsed : [parsed];
}

async function waitForSubmittedJobsToFinish(printerName, initialJobIds, timeoutMs = 30000) {
	await new Promise((resolve) => setTimeout(resolve, 1000));
	const deadline = Date.now() + timeoutMs;
	let pending = [];
	while (Date.now() < deadline) {
		pending = getPrinterJobs(printerName).filter((job) => !initialJobIds.has(Number(job.ID)));
		if (!pending.length) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Windows accepted the print job but did not deliver it: ${JSON.stringify(pending)}`);
}

function canReachDebugger(port) {
	return new Promise((resolve) => {
		const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
			response.resume();
			resolve(response.statusCode === 200);
		});
		request.setTimeout(750, () => request.destroy());
		request.once('error', () => resolve(false));
	});
}

async function waitForDebugger(port, child, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`SSApp exited early with code ${child.exitCode}.`);
		if (await canReachDebugger(port)) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error('Timed out waiting for SSApp DevTools.');
}

async function stopApp(child) {
	if (!child || child.exitCode !== null) return;
	child.kill();
	await Promise.race([
		new Promise((resolve) => child.once('exit', resolve)),
		new Promise((resolve) => setTimeout(resolve, 5000)),
	]);
}

async function run() {
	if (process.platform !== 'win32') {
		console.log('thermal-print-e2e: SKIPPED (physical printing requires Windows)');
		return;
	}

	const printerName = getArgument('printer') || String(process.env.SSAPP_THERMAL_TEST_PRINTER || '').trim();
	if (!printerName) {
		throw new Error('Pass the physical printer explicitly, for example: npm run test:thermal-print:e2e -- --printer="POS-58"');
	}

	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-thermal-print-'));
	const port = await getFreePort();
	const sourceArg = socialStreamRoot.replace(/\\/g, '/').replace(/\/?$/, '/');
	const child = spawn(electronPath, [
		'.',
		'--running-from-source',
		`--filesource=${sourceArg}`,
		'--multiinstance',
		'--disable-logs',
		`--remote-debugging-port=${port}`,
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_DEBUG_LOGS: '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	let browser = null;
	const initialJobIds = new Set(getPrinterJobs(printerName).map((job) => Number(job.ID)));
	child.stdout.on('data', (chunk) => { output += chunk.toString(); });
	child.stderr.on('data', (chunk) => { output += chunk.toString(); });

	try {
		await waitForDebugger(port, child);
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		const page = browser.contexts().flatMap((context) => context.pages())[0];
		assert.ok(page, 'SSApp did not expose its main Electron page.');

		const deadline = Date.now() + 30000;
		let backgroundFrame = null;
		while (Date.now() < deadline) {
			backgroundFrame = page.frames().find((frame) => frame.name() === 'frame2');
			const ready = backgroundFrame && await backgroundFrame.evaluate(() =>
				typeof window.printThermal === 'function' &&
				!!window.eventFlowSystem &&
				typeof window.ninjafy?.printThermal === 'function'
			).catch(() => false);
			if (ready) break;
			backgroundFrame = null;
			await page.waitForTimeout(200);
		}
		assert.ok(backgroundFrame, 'SSApp background/Event Flow runtime did not become ready.');

		let popupFrame = null;
		const popupDeadline = Date.now() + 30000;
		while (Date.now() < popupDeadline) {
			popupFrame = page.frames().find((frame) => frame.name() === 'frame1');
			const ready = popupFrame && await popupFrame.evaluate(() =>
				typeof window.refreshThermalPrinterList === 'function' &&
				typeof window.getThermalPrinterOptionsFromPopup === 'function' &&
				!!document.getElementById('testThermalPrinter')
			).catch(() => false);
			if (ready) break;
			popupFrame = null;
			await page.waitForTimeout(200);
		}
		assert.ok(popupFrame, 'SSApp printer settings UI did not become ready.');
		const popupState = await popupFrame.evaluate(async () => {
			const printers = await window.refreshThermalPrinterList();
			return {
				printers,
				options: window.getThermalPrinterOptionsFromPopup(),
				datalistValues: Array.from(document.querySelectorAll('#thermalPrinterNames option')).map((option) => option.value),
			};
		});
		assert.ok(popupState.printers.some((printer) => printer.name.toLowerCase() === printerName.toLowerCase()),
			`Printer settings UI did not discover ${printerName}: ${JSON.stringify(popupState)}`);
		assert.ok(popupState.datalistValues.some((name) => name.toLowerCase() === printerName.toLowerCase()));
		assert.equal(popupState.options.width, '58mm');
		assert.equal(popupState.options.marginLeft, '2mm');
		assert.equal(popupState.options.marginRight, '2mm');
		assert.equal(popupState.options.marginType, 'printableArea');

		const result = await backgroundFrame.evaluate(async (selectedPrinter) => {
			const actionNode = {
				id: 'physical_thermal_print_test',
				type: 'action',
				actionType: 'customJs',
				config: {
					code: `return printThermal(
						'<div style="border:1px solid #000;padding:2mm">' +
						'<div style="display:flex;justify-content:space-between;font-size:8pt"><b>| LEFT</b><b>RIGHT |</b></div>' +
						'<div style="font-size:18pt;font-weight:bold;text-align:center">BUYER #12</div>' +
						'<div style="font-size:13pt;margin-top:3mm">Inky</div>' +
						'<div style="font-size:13pt">Test Product</div>' +
						'<div style="font-size:8pt;margin-top:3mm;text-align:center">SSApp printable-area E2E</div></div>',
						{ printerName: message.testPrinterName, fontSize: '10pt' }
					).then((printResult) => ({
						...result,
						modified: true,
						message: { ...message, thermalPrintResult: printResult }
					}));`,
				},
			};
			return await window.eventFlowSystem.executeAction(actionNode, {
				type: 'test',
				chatname: 'Inky',
				chatmessage: 'Test Product',
				testPrinterName: selectedPrinter,
			}, { id: 'physical_print_test', nodes: [actionNode], connections: [] });
		}, printerName);

		assert.equal(result?.modified, true, `Event Flow did not return a modified message: ${JSON.stringify(result)}`);
		assert.equal(result?.message?.thermalPrintResult?.success, true, JSON.stringify(result?.message?.thermalPrintResult));
		assert.equal(result.message.thermalPrintResult.printerName.toLowerCase(), printerName.toLowerCase());
		assert.equal(result.message.thermalPrintResult.marginType, 'printableArea');
		assert.deepEqual(result.message.thermalPrintResult.margins, { top: '2mm', right: '2mm', bottom: '2mm', left: '2mm' });
		await waitForSubmittedJobsToFinish(printerName, initialJobIds);
		console.log(`thermal-print-e2e: PASS (${JSON.stringify(result.message.thermalPrintResult)})`);
	} catch (error) {
		if (output) console.error(output.trim());
		throw error;
	} finally {
		if (browser) await browser.close().catch(() => {});
		await stopApp(child);
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

run().catch((error) => {
	console.error(error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
