// Ensures the Electron binary is downloaded after `npm install`.
//
// Some registry proxies (e.g. the Microsoft npm proxy) serve an `electron`
// tarball whose package.json has the `scripts` field stripped, and an
// abbreviated packument without `hasInstallScript`. npm therefore never runs
// Electron's own `postinstall`, leaving node_modules/electron without its
// `dist/` binary and making `electron-vite dev` fail with "Electron uninstall".
//
// Electron's install.js is idempotent and cache-backed, so re-running it on
// every install is effectively free once the binary is present.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = join(root, 'node_modules', 'electron', 'install.js');

// Electron is a devDependency; it is legitimately absent for --omit=dev installs.
if (!existsSync(installer)) {
  process.exit(0);
}

try {
  execFileSync(process.execPath, [installer], { stdio: 'inherit', cwd: root });
} catch {
  console.error('\nFailed to download the Electron binary.');
  console.error('Retry with: node node_modules/electron/install.js\n');
  process.exit(1);
}
