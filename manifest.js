// The app loads the real Social Stream manifest from manifest.json during startup.
// This placeholder prevents a missing local script error before that async load completes.
var manifest = window.manifest || { content_scripts: [] };
