/**
 * Type declarations for `pixelmatch` v6.
 *
 * v6 ships no declarations of its own, and the published `@types/pixelmatch`
 * package describes the v5 API (different option names, CommonJS export). A
 * mismatched types package is worse than none: it type-checks against a shape
 * the runtime does not have. This declares what v6 actually exports.
 */
declare module 'pixelmatch' {
  interface PixelmatchOptions {
    /** Matching threshold, 0 to 1. Smaller is more sensitive. Default 0.1. */
    threshold?: number;
    /** Detect and ignore anti-aliased pixels. Default false. */
    includeAA?: boolean;
    /** Opacity of the unchanged image in the diff output. Default 0.1. */
    alpha?: number;
    /** RGB colour used for anti-aliased pixels. */
    aaColor?: [number, number, number];
    /** RGB colour used for differing pixels. */
    diffColor?: [number, number, number];
    /** RGB colour used for differing pixels where the second image is darker. */
    diffColorAlt?: [number, number, number];
    /** Draw the diff over a transparent background. */
    diffMask?: boolean;
  }

  /**
   * Compare two RGBA buffers of identical dimensions, writing the visual diff
   * into `output`. Returns the number of differing pixels.
   */
  export default function pixelmatch(
    img1: Uint8Array | Buffer,
    img2: Uint8Array | Buffer,
    output: Uint8Array | Buffer | null,
    width: number,
    height: number,
    options?: PixelmatchOptions,
  ): number;
}
