import { pathToFileURL } from 'node:url';
import { cosmiconfig } from 'cosmiconfig';
import type { z } from 'zod';
import { ConfigError } from '../core/errors.js';
import { configSchema, type DrifterConfig } from './schema.js';

const MODULE_NAME = 'drifter';

/** Turn a Zod error into something a human can act on immediately. */
function formatZodError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return `Invalid configuration:\n${lines.join('\n')}`;
}

/**
 * Environment overrides.
 *
 * A CI pipeline should be able to point the same committed config at a
 * different pair of environments - a preview deployment, a release candidate -
 * without rewriting and committing the file. Applied after the file and before
 * explicit `overrides`, so a CLI flag still wins.
 */
const ENV_OVERRIDES: Array<{
  env: string;
  apply: (config: Record<string, unknown>, value: string) => void;
}> = [
  {
    env: 'DRIFTER_SOURCE_BASE_URL',
    apply: (config, value) => {
      config['source'] = { ...(config['source'] as object), baseUrl: value };
    },
  },
  {
    env: 'DRIFTER_TARGET_BASE_URL',
    apply: (config, value) => {
      config['target'] = { ...(config['target'] as object), baseUrl: value };
    },
  },
  {
    env: 'DRIFTER_OUT_DIR',
    apply: (config, value) => {
      config['output'] = { ...(config['output'] as object), dir: value };
    },
  },
  {
    env: 'DRIFTER_MAX_PAGES',
    apply: (config, value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        config['crawl'] = { ...(config['crawl'] as object), maxPages: parsed };
      }
    },
  },
];

/** Apply `DRIFTER_*` environment overrides to a raw config object. */
export function applyEnvOverrides(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const out = { ...config };
  for (const { env: name, apply } of ENV_OVERRIDES) {
    const value = env[name];
    // An empty value is treated as unset: a pipeline parameter left blank
    // should not blank out the configured URL and fail schema validation.
    if (value !== undefined && value.trim() !== '') apply(out, value.trim());
  }
  return out;
}

export interface LoadedConfig {
  config: DrifterConfig;
  /** Absolute path of the config file, or null when defaults-only. */
  filepath: string | null;
}

/**
 * Load and validate configuration.
 *
 * Searches for `drifter.config.{ts,mts,js,mjs,cjs,json}`, `.drifterrc*`, or a
 * `drifter` key in package.json - or loads an explicit path when given.
 * `overrides` are shallow-merged last so CLI flags beat the file.
 */
export async function loadConfig(
  options: {
    configPath?: string | undefined;
    cwd?: string | undefined;
    overrides?: Record<string, unknown> | undefined;
  } = {},
): Promise<LoadedConfig> {
  const { configPath, cwd = process.cwd(), overrides = {} } = options;

  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      'package.json',
      `.${MODULE_NAME}rc`,
      `.${MODULE_NAME}rc.json`,
      `.${MODULE_NAME}rc.js`,
      `.${MODULE_NAME}rc.mjs`,
      `${MODULE_NAME}.config.ts`,
      `${MODULE_NAME}.config.mts`,
      `${MODULE_NAME}.config.js`,
      `${MODULE_NAME}.config.mjs`,
      `${MODULE_NAME}.config.cjs`,
      `${MODULE_NAME}.config.json`,
    ],
    loaders: {
      // TypeScript and ESM config files are loaded through the active runtime
      // loader (tsx in dev, plain ESM after a build).
      '.ts': tsLoader,
      '.mts': tsLoader,
      '.mjs': esmLoader,
      '.js': esmLoader,
    },
  });

  let result;
  try {
    result = configPath ? await explorer.load(configPath) : await explorer.search(cwd);
  } catch (cause) {
    throw new ConfigError(
      `Could not read configuration${configPath ? ` from ${configPath}` : ''}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }

  if (!result || result.isEmpty) {
    throw new ConfigError(
      configPath
        ? `Configuration file is empty: ${configPath}`
        : `No drifter configuration found in ${cwd}. Run \`drifter init\` to create one.`,
    );
  }

  const merged = {
    ...applyEnvOverrides(result.config as Record<string, unknown>),
    ...overrides,
  };

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`${formatZodError(parsed.error)}\n  (from ${result.filepath})`);
  }

  return { config: parsed.data, filepath: result.filepath };
}

async function esmLoader(filepath: string): Promise<unknown> {
  // pathToFileURL (not manual `file://` concatenation) so paths containing
  // spaces or other characters needing percent-encoding still resolve.
  const url = pathToFileURL(filepath);
  // Cache-bust so a config edited between runs in one process is re-read.
  url.searchParams.set('t', String(Date.now()));
  const mod: unknown = await import(url.href);
  return unwrapDefault(mod);
}

async function tsLoader(filepath: string): Promise<unknown> {
  try {
    return await esmLoader(filepath);
  } catch (cause) {
    throw new ConfigError(
      `Could not load TypeScript config ${filepath}. Run through \`tsx\` ` +
        `(\`npm run dev\`) or use a .js/.json config.`,
      { cause },
    );
  }
}

function unwrapDefault(mod: unknown): unknown {
  if (mod && typeof mod === 'object' && 'default' in mod) {
    return mod.default;
  }
  return mod;
}

/** Validate an already-in-memory config object (used by tests and the API). */
export function parseConfig(input: unknown): DrifterConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError(formatZodError(parsed.error));
  return parsed.data;
}
