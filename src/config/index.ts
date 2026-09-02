export { defineConfig, configSchema } from './schema.js';
export type { DrifterConfig, DrifterConfigInput } from './schema.js';
export { loadConfig, parseConfig } from './load.js';
export type { LoadedConfig } from './load.js';
export {
  BUILT_IN_DEVICES,
  DEFAULT_VIEWPORT_IDS,
  PRIMARY_VIEWPORT_ID,
  getBuiltInDevice,
  listBuiltInDeviceIds,
  resolveDevices,
} from './devices.js';
export type { DeviceProfile } from './devices.js';
