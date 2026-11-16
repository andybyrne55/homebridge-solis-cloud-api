import { readFileSync } from 'node:fs';

/** Platform name used in the Homebridge config.json. */
export const PLATFORM_NAME = 'SolisCloudAPI';

/** Must match the `name` in package.json. */
export const PLUGIN_NAME = 'homebridge-solis-cloud-api';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Plugin version, shown as the accessories' firmware revision. */
export const PLUGIN_VERSION = readVersion();
