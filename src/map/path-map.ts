import type { DrifterConfig } from '../config/schema.js';

/**
 * Source path → target path mapping.
 *
 * The premise of the whole tool is that paths are preserved, so the default
 * mapping is the identity. But a real migration always has exceptions - a
 * legacy CMS emits `/products.aspx` where the rewrite serves `/products`, and a
 * platform move often reshapes one section wholesale.
 *
 * Rules are applied most-specific first:
 *
 *   1. exact `overrides` - hand-written, unambiguous, wins over everything
 *   2. `rewrites` - regex, in declaration order, first match wins
 *   3. identity
 *
 * The mapping is deliberately one-directional (source drives the comparison),
 * with a reverse lookup built alongside it so "extra pages on the target" can
 * still be identified without guessing an inverse for every regex.
 */

export interface PathMapping {
  /** Target path a source path is expected to appear at. */
  toTarget(sourcePath: string): string;
  /** Source path a target path came from, when one is known. */
  toSource(targetPath: string): string | null;
  /** True when the mapping is not the identity for this path. */
  isRemapped(sourcePath: string): boolean;
}

export type PathMapConfig = Pick<DrifterConfig['urlMapping'], 'overrides' | 'rewrites'>;

export function createPathMapping(config: PathMapConfig): PathMapping {
  const overrides = new Map(Object.entries(config.overrides));
  const reverseOverrides = new Map(
    Object.entries(config.overrides).map(([from, to]) => [to, from]),
  );

  const cache = new Map<string, string>();

  const toTarget = (sourcePath: string): string => {
    const cached = cache.get(sourcePath);
    if (cached !== undefined) return cached;

    let result = overrides.get(sourcePath);

    if (result === undefined) {
      result = sourcePath;
      for (const rule of config.rewrites) {
        // Rebuilt per use so a /g pattern cannot carry lastIndex between calls.
        const pattern = new RegExp(rule.from.source, rule.from.flags);
        if (pattern.test(sourcePath)) {
          result = sourcePath.replace(pattern, rule.to);
          break;
        }
      }
    }

    cache.set(sourcePath, result);
    return result;
  };

  return {
    toTarget,
    isRemapped: (sourcePath) => toTarget(sourcePath) !== sourcePath,
    toSource(targetPath) {
      const override = reverseOverrides.get(targetPath);
      if (override !== undefined) return override;
      // Regex rewrites are not generally invertible, so identity is the only
      // safe answer. Callers treat null as "unknown", not as "no source".
      return targetPath;
    },
  };
}
