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

  const merged = { ...(result.config as Record<string, unknown>), ...overrides };

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
