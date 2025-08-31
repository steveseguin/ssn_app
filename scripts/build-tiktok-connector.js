const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

function run(cmd, args, cwd) {
  const env = { ...process.env, NODE_ENV: '', npm_config_production: 'false' };
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true, env });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with code ${res.status}`);
  }
}

try {
  const modPath = join(process.cwd(), 'node_modules', 'tiktok-live-connector');
  const distPath = join(modPath, 'dist');

  if (existsSync(modPath) && !existsSync(distPath)) {
    console.log('[postinstall] tiktok-live-connector: dist not found, attempting to build…');
    // Some forks require install and build to produce dist
    try {
      // Ensure dev dependencies are installed inside the module
      run('npm', ['ci', '--no-audit', '--fund=false', '--include=dev'], modPath);
    } catch {
      // Fallback if ci fails
      run('npm', ['install', '--no-audit', '--fund=false', '--include=dev'], modPath);
    }
    run('npm', ['run', 'build'], modPath);
    console.log('[postinstall] tiktok-live-connector: build completed.');
  } else {
    console.log('[postinstall] tiktok-live-connector: dist present, skipping build.');
  }
} catch (e) {
  console.warn('[postinstall] tiktok-live-connector: build skipped or failed:', e.message);
}
