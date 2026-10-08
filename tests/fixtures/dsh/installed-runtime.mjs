// The optional suite requires an explicitly selected installation. No install or global update.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function requireDshInstall(value = process.env.PEROS_DSH_ROOT) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('DSH_NOT_CONFIGURED: set PEROS_DSH_ROOT to an existing @deepseek-ai/dsh installation before running the optional DSH suite');
  const installRoot = resolve(value);
  if (!existsSync(join(installRoot, 'lib/bin.js'))) throw new Error(`DSH_NOT_AVAILABLE: ${installRoot} does not contain lib/bin.js`);
  const packageInfo = JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8'));
  if (packageInfo.name !== '@deepseek-ai/dsh') throw new Error('DSH_INSTALL_INVALID: selected installation is not @deepseek-ai/dsh');
  return { installRoot, version: packageInfo.version };
}
