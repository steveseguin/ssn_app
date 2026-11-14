"use strict";

const fs = require("fs").promises;
const path = require("path");

const STORE_KEY = "musicSourceFile";
const MAX_BYTES = 64 * 1024;
const TOO_LARGE_MESSAGE = "The music file must be 64 KB or smaller.";

// Lets the Music panel choose one current-song file and the host page poll its contents.
// Only the chosen path is ever read, and the path itself stays in the main process.
function setupMusicFile({ ipcMain, dialog, store, isTrustedSender }) {
	ipcMain.handle("ssapp:music-file-select", async (event) => {
		if (!isTrustedSender(event)) throw new Error("Music file selection requires the SSN music panel.");
		const result = await dialog.showOpenDialog({
			title: "Select current song file",
			properties: ["openFile"],
			filters: [{ name: "Track information", extensions: ["txt", "json"] }],
		});
		if (result.canceled || !result.filePaths.length) return { canceled: true };
		const selected = result.filePaths[0];
		const stat = await fs.stat(selected);
		if (!stat.isFile() || stat.size > MAX_BYTES) return { error: "Select a text or JSON file that is 64 KB or smaller." };
		store.set(STORE_KEY, selected);
		return { canceled: false, name: path.basename(selected) };
	});

	ipcMain.handle("ssapp:music-file-read", async (event) => {
		if (!isTrustedSender(event)) throw new Error("Music file reading requires the SSN music panel.");
		const selected = store.get(STORE_KEY);
		if (!selected) return { error: "Select a current song file." };
		let file;
		try {
			file = await fs.open(selected, "r");
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > MAX_BYTES) return { error: TOO_LARGE_MESSAGE };
			// One spare byte reveals a file that grew past the limit after the size check.
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_BYTES) return { error: TOO_LARGE_MESSAGE };
			return {
				text: buffer.subarray(0, bytesRead).toString("utf8"),
				modifiedAt: stat.mtimeMs,
				name: path.basename(selected),
			};
		} catch (_) {
			return { error: "Cannot read the current song file. Select it again." };
		} finally {
			if (file) await file.close();
		}
	});
}

module.exports = { setupMusicFile };
