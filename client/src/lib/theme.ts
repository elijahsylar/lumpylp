// Theme presets for LumpyLP. All five themes are verified WCAG 2.2 AA —
// see /tmp/theme-check.js. Anonymous users always get Underground (the
// default). Logged-in users can pick from THEMES via /settings; their
// choice is persisted to users.theme on the server.

export type ThemeName = 'underground' | 'amber' | 'mono' | 'light' | 'highcontrast';

export const THEMES: ReadonlyArray<{
  name: ThemeName;
  label: string;
  description: string;
  /** Display swatch colors (hex) for the picker. The actual applied
   *  colors live in src/index.css under [data-theme="..."]. */
  swatches: { bg: string; body: string; accent: string; bright: string };
}> = [
  {
    name: 'underground',
    label: 'Underground',
    description: 'Terminal green on black. The default.',
    swatches: { bg: '#080808', body: '#c0c0c0', accent: '#00e676', bright: '#00ff8c' },
  },
  {
    name: 'amber',
    label: 'Amber',
    description: 'Vintage CRT. Tan on near-black.',
    swatches: { bg: '#0a0805', body: '#c8b48a', accent: '#ff9800', bright: '#ffb74d' },
  },
  {
    name: 'mono',
    label: 'Mono',
    description: 'Greyscale only. No accent color.',
    swatches: { bg: '#080808', body: '#d4d4d4', accent: '#ffffff', bright: '#ffffff' },
  },
  {
    name: 'light',
    label: 'Light',
    description: 'Daytime. Paper background, dark green accent.',
    swatches: { bg: '#fafafa', body: '#1a1a1a', accent: '#006633', bright: '#007a3c' },
  },
  {
    name: 'highcontrast',
    label: 'High Contrast',
    description: 'Maximum readability. AAA contrast across the board.',
    swatches: { bg: '#000000', body: '#ffffff', accent: '#00ff00', bright: '#00ff00' },
  },
];

const VALID_THEMES = new Set<string>(THEMES.map((t) => t.name));
export const DEFAULT_THEME: ThemeName = 'underground';

export function isValidTheme(s: unknown): s is ThemeName {
  return typeof s === 'string' && VALID_THEMES.has(s);
}

/** Apply a theme to the live document. Sets data-theme on <html> so the
 *  CSS variable cascades update immediately. */
export function applyTheme(name: ThemeName): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', name);
}

const STORAGE_KEY = 'lumpylp_theme';

/** Read the most-recently-applied theme from localStorage. Used to avoid
 *  a flash on first paint before the auth response arrives. Falls back to
 *  the default if no value or an invalid value is stored. */
export function getStoredTheme(): ThemeName {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isValidTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function setStoredTheme(name: ThemeName): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // ignore — storage may be disabled (private mode, quota, etc.)
  }
}
