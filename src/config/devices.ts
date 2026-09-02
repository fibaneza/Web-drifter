/**
 * Device profiles for multi-viewport comparison.
 *
 * These are deliberately pinned here rather than pulled from Playwright's
 * `devices` registry. That registry lags hardware releases and its keys change
 * between Playwright versions, so `devices['iPhone 17']` may simply not exist
 * and a Playwright upgrade could break a working run. Declaring explicit
 * dimensions means adding a new phone is a config line, not a dependency bump.
 *
 * Callers may still opt into the registry per profile via `playwrightDevice`.
 *
 * NOTE ON ACCURACY: the logical viewport sizes below are the CSS-pixel sizes
 * these device classes report. Before relying on a specific handset - the
 * `mobile-lg` / iPhone-17-class entry in particular - verify the numbers
 * against the real device or the vendor's published specification and adjust
 * the profile. That is a one-line change by design.
 */

export interface DeviceProfile {
  /** Stable id used in config, findings and report filters. */
  id: string;
  /** Human label shown in reports. */
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent?: string;
  /** Optional escape hatch: use a Playwright registry device instead. */
  playwrightDevice?: string;
}

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';

const TABLET_UA =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export const BUILT_IN_DEVICES: readonly DeviceProfile[] = [
  {
    id: 'mobile-sm',
    label: 'Small phone (360x740)',
    width: 360,
    height: 740,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_UA,
  },
  {
    id: 'mobile-md',
    label: 'Medium phone / iPhone 15-16 class (393x852)',
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: MOBILE_UA,
  },
  {
    id: 'mobile-lg',
    label: 'Large phone / iPhone 17 class (402x874)',
    width: 402,
    height: 874,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: MOBILE_UA,
  },
  {
    id: 'mobile-xl',
    label: 'Phone Max / Pro Max class (440x956)',
    width: 440,
    height: 956,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: MOBILE_UA,
  },
  {
    id: 'tablet',
    label: 'Tablet portrait (768x1024)',
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: TABLET_UA,
  },
  {
    id: 'tablet-landscape',
    label: 'Tablet landscape (1024x768)',
    width: 1024,
    height: 768,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: TABLET_UA,
  },
  {
    id: 'desktop',
    label: 'Desktop (1440x900)',
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  {
    id: 'desktop-xl',
    label: 'Large desktop (1920x1080)',
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
] as const;

/** Enabled unless the config says otherwise: one desktop, one tablet, two phones. */
export const DEFAULT_VIEWPORT_IDS = ['desktop', 'tablet', 'mobile-md', 'mobile-sm'] as const;

/**
 * The viewport at which viewport-independent data (content, links, images,
 * prices, meta) is extracted exactly once. Styles, geometry and visibility are
 * still captured at every enabled viewport.
 */
export const PRIMARY_VIEWPORT_ID = 'desktop';

const BY_ID = new Map<string, DeviceProfile>(BUILT_IN_DEVICES.map((d) => [d.id, d]));

export function getBuiltInDevice(id: string): DeviceProfile | undefined {
  return BY_ID.get(id);
}

export function listBuiltInDeviceIds(): string[] {
  return BUILT_IN_DEVICES.map((d) => d.id);
}

/**
 * Resolve viewport ids to profiles, letting user-declared profiles override or
 * extend the built-ins. Throws on an unknown id so a typo fails loudly rather
 * than silently skipping a screen size.
 */
export function resolveDevices(
  ids: readonly string[],
  custom: readonly DeviceProfile[] = [],
): DeviceProfile[] {
  const table = new Map(BY_ID);
  for (const profile of custom) table.set(profile.id, profile);

  return ids.map((id) => {
    const profile = table.get(id);
    if (!profile) {
      const known = [...table.keys()].sort().join(', ');
      throw new Error(`Unknown viewport "${id}". Known viewports: ${known}`);
    }
    return profile;
  });
}
