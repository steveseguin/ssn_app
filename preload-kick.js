'use strict';

const path = require("path");

// Kick's normal sign-in needs the lighter Kasada setup, while Google needs the
// fuller browser mocks. Preloads run again for every top-level navigation, so
// the same BrowserWindow can safely use a different setup after Kick redirects.
const isGoogleSignIn = location.hostname.toLowerCase() === "accounts.google.com";

require(path.join(__dirname, isGoogleSignIn ? "preload-mock.js" : "preload-kasada.js"));
