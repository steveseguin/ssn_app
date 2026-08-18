"use strict";

const path = require("path");

const RESTRICT_MOCK_PAGE_IPC_FLAG = "__ssappRestrictMockPageIpc";

// Kick's normal sign-in page needs the lighter Kasada setup, while Google needs
// the fuller browser mocks. Preloads run again for every top-level navigation,
// so one BrowserWindow can safely support both routes.
const isGoogleSignIn = location.hostname.toLowerCase() === "accounts.google.com";

if (isGoogleSignIn) {
	const nodeProcess = process;
	nodeProcess[RESTRICT_MOCK_PAGE_IPC_FLAG] = true;
	try {
		require(path.join(__dirname, "preload-mock.js"));
	} finally {
		delete nodeProcess[RESTRICT_MOCK_PAGE_IPC_FLAG];
	}
} else {
	require(path.join(__dirname, "preload-kasada.js"));
}
