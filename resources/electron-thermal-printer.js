'use strict';

const DEFAULT_WIDTH_MICRONS = 58000;
const MIN_WIDTH_MICRONS = 20000;
const MAX_WIDTH_MICRONS = 120000;
const MIN_HEIGHT_MICRONS = 20000;
const MAX_HEIGHT_MICRONS = 4000000;
const CSS_PIXELS_PER_INCH = 96;
const MICRONS_PER_INCH = 25400;

function createPrintError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function parseLengthMicrons(value, fallback, minimum, maximum) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.max(minimum, Math.min(maximum, Math.round(value * 1000)));
	}

	const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*(mm|cm|in)?$/i);
	if (!match) return fallback;
	const amount = Number(match[1]);
	const unit = String(match[2] || 'mm').toLowerCase();
	const multiplier = unit === 'in' ? MICRONS_PER_INCH : unit === 'cm' ? 10000 : 1000;
	return Math.max(minimum, Math.min(maximum, Math.round(amount * multiplier)));
}

function parseOptionalLengthMicrons(value, minimum, maximum) {
	if (value === undefined || value === null || value === '') return 0;
	if (/^0+(?:\.0+)?\s*(?:mm|cm|in)?$/i.test(String(value).trim())) return 0;
	return parseLengthMicrons(value, 0, minimum, maximum);
}

function normalizeCssLength(value, fallback, maximum) {
	const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*(mm|cm|in|px|pt)?$/i);
	if (!match) return fallback;
	const amount = Math.min(maximum, Number(match[1]));
	return `${amount}${String(match[2] || 'mm').toLowerCase()}`;
}

function normalizeFontFamily(value) {
	const family = String(value || 'monospace').trim().slice(0, 200);
	return /^[\w\s,'"-]+$/.test(family) ? family : 'monospace';
}

function normalizeLineHeight(value) {
	const amount = Number(value);
	if (!Number.isFinite(amount)) return '1.2';
	return String(Math.max(0.8, Math.min(3, amount)));
}

function normalizeMarginType(value) {
	return String(value || '').toLowerCase() === 'none' ? 'none' : 'printableArea';
}

function normalizePrintOptions(options = {}) {
	const hasSharedMargin = Object.prototype.hasOwnProperty.call(options, 'margin');
	const sharedMargin = hasSharedMargin ? normalizeCssLength(options.margin, '0mm', 25) : null;
	return {
		printerName: String(options.printerName || '').trim().slice(0, 256),
		widthMicrons: parseLengthMicrons(options.width, DEFAULT_WIDTH_MICRONS, MIN_WIDTH_MICRONS, MAX_WIDTH_MICRONS),
		heightMicrons: parseOptionalLengthMicrons(options.height, MIN_HEIGHT_MICRONS, MAX_HEIGHT_MICRONS),
		marginTop: normalizeCssLength(options.marginTop, sharedMargin || '0mm', 25),
		marginRight: normalizeCssLength(options.marginRight, sharedMargin || '2mm', 25),
		marginBottom: normalizeCssLength(options.marginBottom, sharedMargin || '0mm', 25),
		marginLeft: normalizeCssLength(options.marginLeft, sharedMargin || '2mm', 25),
		feedMicrons: parseLengthMicrons(options.feed, 1000, 0, 25000),
		marginType: normalizeMarginType(options.marginType),
		fontSize: normalizeCssLength(options.fontSize, '10pt', 72),
		fontFamily: normalizeFontFamily(options.fontFamily),
		lineHeight: normalizeLineHeight(options.lineHeight),
		copies: Math.max(1, Math.min(99, Math.floor(Number(options.copies) || 1))),
	};
}

function buildPrintDocument(htmlContent, options) {
	const widthMm = options.widthMicrons / 1000;
	const heightRule = options.heightMicrons ? `${options.heightMicrons / 1000}mm` : 'auto';
	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'">
	<style>
		@page { size: ${widthMm}mm ${heightRule}; margin: 0; }
		html, body { width: 100%; margin: 0; padding: 0; }
		body {
			box-sizing: border-box;
			font-family: ${options.fontFamily};
			font-size: ${options.fontSize};
			line-height: ${options.lineHeight};
			color: #000;
			background: #fff;
		}
		#ssapp-thermal-print-root {
			box-sizing: border-box;
			width: 100%;
			padding: ${options.marginTop} ${options.marginRight} ${options.marginBottom} ${options.marginLeft};
			overflow-wrap: anywhere;
		}
		*, *::before, *::after { box-sizing: border-box; }
		img { max-width: 100%; height: auto; }
	</style>
</head>
<body><div id="ssapp-thermal-print-root">${htmlContent}</div></body>
</html>`;
}

class ElectronThermalPrinter {
	constructor({ BrowserWindow }) {
		if (!BrowserWindow) throw new Error('BrowserWindow is required');
		this.BrowserWindow = BrowserWindow;
		this.queueTail = Promise.resolve();
		this.activeWindows = new Set();
		this.stopped = false;
	}

	print(htmlContent, options = {}) {
		if (this.stopped) {
			return Promise.reject(createPrintError('SSAPP_PRINT_STOPPED', 'Thermal printing is shutting down.'));
		}
		const html = String(htmlContent || '');
		if (!html.trim()) {
			return Promise.reject(createPrintError('SSAPP_PRINT_EMPTY', 'Nothing was provided to print.'));
		}
		if (Buffer.byteLength(html, 'utf8') > 1024 * 1024) {
			return Promise.reject(createPrintError('SSAPP_PRINT_TOO_LARGE', 'Thermal print content is larger than 1 MB.'));
		}

		const job = this.queueTail.then(() => this.runPrintJob(html, normalizePrintOptions(options)));
		this.queueTail = job.catch(() => {});
		return job;
	}

	async runPrintJob(htmlContent, options) {
		if (this.stopped) throw createPrintError('SSAPP_PRINT_STOPPED', 'Thermal printing is shutting down.');

		const printWindow = new this.BrowserWindow({
			show: false,
			width: Math.max(240, Math.ceil(options.widthMicrons / 100)),
			height: 600,
			webPreferences: {
				backgroundThrottling: false,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		});
		this.activeWindows.add(printWindow);

		try {
			const documentHtml = buildPrintDocument(htmlContent, options);
			await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(documentHtml)}`);
			await printWindow.webContents.executeJavaScript(`(async () => {
				if (document.fonts && document.fonts.ready) await document.fonts.ready;
				await Promise.race([
					Promise.all(Array.from(document.images).map((image) => image.complete
						? Promise.resolve()
						: new Promise((resolve) => {
							image.addEventListener('load', resolve, { once: true });
							image.addEventListener('error', resolve, { once: true });
						}))),
					new Promise((resolve) => setTimeout(resolve, 10000)),
				]);
				await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			})()`);

			const printers = await printWindow.webContents.getPrintersAsync();
			let selectedPrinter = null;
			if (options.printerName) {
				const requested = options.printerName.toLowerCase();
				selectedPrinter = printers.find((printer) =>
					String(printer.name || '').toLowerCase() === requested ||
					String(printer.displayName || '').toLowerCase() === requested
				);
				if (!selectedPrinter) {
					throw createPrintError(
						'SSAPP_PRINTER_NOT_FOUND',
						`Printer "${options.printerName}" was not found. Available printers: ${printers.map((printer) => printer.name).join(', ') || 'none'}`
					);
				}
			} else {
				selectedPrinter = printers.find((printer) => printer.isDefault) || null;
			}

			const contentHeightPx = await printWindow.webContents.executeJavaScript(`Math.max(
				document.getElementById('ssapp-thermal-print-root').scrollHeight,
				document.getElementById('ssapp-thermal-print-root').getBoundingClientRect().height
			)`);
			const measuredHeightMicrons = Math.ceil((Number(contentHeightPx) || 0) * MICRONS_PER_INCH / CSS_PIXELS_PER_INCH);
			const pageHeightMicrons = options.heightMicrons || Math.max(
				MIN_HEIGHT_MICRONS,
				Math.min(MAX_HEIGHT_MICRONS, measuredHeightMicrons + options.feedMicrons)
			);

			const printOptions = {
				silent: true,
				printBackground: true,
				color: false,
				margins: { marginType: options.marginType },
				landscape: false,
				copies: options.copies,
				pageSize: {
					width: options.widthMicrons,
					height: pageHeightMicrons,
				},
			};
			if (selectedPrinter && selectedPrinter.name) printOptions.deviceName = selectedPrinter.name;

			await new Promise((resolve, reject) => {
				let settled = false;
				const timeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(createPrintError('SSAPP_PRINT_TIMEOUT', 'Windows did not finish submitting the print job.'));
				}, 30000);
				printWindow.webContents.print(printOptions, (success, failureReason) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					if (success) {
						resolve();
						return;
					}
					reject(createPrintError('SSAPP_PRINT_FAILED', failureReason || 'Windows rejected the print job.'));
				});
			});

			return {
				success: true,
				printerName: selectedPrinter && selectedPrinter.name ? selectedPrinter.name : '',
				widthMicrons: options.widthMicrons,
				heightMicrons: pageHeightMicrons,
				marginType: options.marginType,
				margins: {
					top: options.marginTop,
					right: options.marginRight,
					bottom: options.marginBottom,
					left: options.marginLeft,
				},
				feedMicrons: options.feedMicrons,
				fixedHeight: options.heightMicrons > 0,
			};
		} finally {
			this.activeWindows.delete(printWindow);
			if (!printWindow.isDestroyed()) printWindow.destroy();
		}
	}

	stop() {
		this.stopped = true;
		for (const printWindow of this.activeWindows) {
			try {
				if (!printWindow.isDestroyed()) printWindow.destroy();
			} catch (_) { }
		}
		this.activeWindows.clear();
	}
}

module.exports = {
	ElectronThermalPrinter,
	buildPrintDocument,
	normalizePrintOptions,
};
