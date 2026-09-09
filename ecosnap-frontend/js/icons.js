/* icons.js — the app's icon set.
 *
 * Drawn as inline SVG on a 24x24 grid with a single 1.6 stroke, round caps and
 * joins, and currentColor throughout, so an icon inherits the colour and
 * optical weight of the text beside it.
 *
 * These replace the emoji this app used to render as icons. Emoji are a
 * different typeface on every platform, they carry their own colour, and they
 * cannot be sized or aligned against a type scale -- which is exactly why an
 * interface built from them never looks drawn.
 */

const PATHS = {
  // Navigation
  camera:
    '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2a1 1 0 0 0 .83-.45l.94-1.4A1 1 0 0 1 9.3 4.7h5.4a1 1 0 0 1 .83.45l.94 1.4a1 1 0 0 0 .83.45h2.2A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><circle cx="12" cy="12.8" r="3.4"/>',
  map:
    '<path d="m9 5-5.3 2.1a1 1 0 0 0-.7 1V19a.6.6 0 0 0 .85.55L9 17.4"/><path d="m15 6.6 5.15-2.06A.6.6 0 0 1 21 5.1v10.9a1 1 0 0 1-.7.93L15 19"/><path d="M9 5v12.4"/><path d="M15 6.6V19"/>',
  ranking:
    '<path d="M4 20h16"/><rect x="4.5" y="12" width="4" height="5" rx="1"/><rect x="10" y="7" width="4" height="10" rx="1"/><rect x="15.5" y="14" width="4" height="3" rx="1"/>',
  impact:
    '<path d="M12 20.5V11"/><path d="M12 11c0-3.6 2.6-6.5 8-6.9.4 3.9-1.6 8.1-8 6.9z"/><path d="M12 14.4C11.4 11.7 9.2 9.6 4.7 9.3c-.3 3 1.2 6.2 6 5.4z"/>',
  gift:
    '<rect x="3.5" y="9.5" width="17" height="10.5" rx="1.4"/><path d="M2.6 6.6h18.8v2.9H2.6z" /><path d="M12 6.6v13.4"/><path d="M12 6.6S10.8 3 8.6 3a2 2 0 0 0 0 3.6z"/><path d="M12 6.6S13.2 3 15.4 3a2 2 0 0 1 0 3.6z"/>',

  // Hazard categories — the only icons that carry their own hue.
  flame:
    '<path d="M12 21.6c3.8 0 6.6-2.8 6.6-6.4 0-5.1-5.3-6.9-3.7-12.8-3.6 1-7 4.9-7 8.5 0 1.2.3 2.2 1 3-1.5.2-3-1.2-3.5-2.9a8 8 0 0 0-1 3.7c0 3.9 3.8 6.9 7.6 6.9z"/><path d="M12 21.6c1.8 0 3.1-1.3 3.1-3 0-2.3-2.7-3-2-5.7-1.8.6-3.5 2.5-3.5 4.3 0 2.4 1.2 4.4 2.4 4.4z"/>',
  drain:
    '<rect x="3.4" y="7.4" width="17.2" height="12.6" rx="2"/><path d="M8.7 7.4V20"/><path d="M12 7.4V20"/><path d="M15.3 7.4V20"/><path d="M12 4.6V2.4"/><path d="M8.2 5.1 7 3.3"/><path d="M15.8 5.1 17 3.3"/>',
  pin:
    '<path d="M12 21s6.5-5.6 6.5-10.2a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21z"/><circle cx="12" cy="10.8" r="2.4"/>',

  // Status & states
  alert:
    '<path d="M10.6 3.9 2.5 18a1.6 1.6 0 0 0 1.4 2.4h16.2A1.6 1.6 0 0 0 21.5 18L13.4 3.9a1.6 1.6 0 0 0-2.8 0z"/><path d="M12 9.4v4.2"/><circle cx="12" cy="16.9" r=".2"/>',
  offline:
    '<path d="M3 3l18 18"/><path d="M9.5 5.2A7 7 0 0 1 19 11.7"/><path d="M5.4 8.6A7 7 0 0 0 5 11.7"/><path d="M8.6 12.4a3.4 3.4 0 0 1 4.6-.7"/><circle cx="12" cy="18.2" r=".3"/>',
  check:
    '<path d="M4.5 12.6 9.5 17.5 19.5 6.9"/>',
  clock:
    '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',

  // Rewards
  signal:
    '<path d="M4 20V14"/><path d="M9.3 20V10.4"/><path d="M14.7 20V6.8"/><path d="M20 20V4"/>',
  phone:
    '<rect x="6.5" y="2.8" width="11" height="18.4" rx="2"/><path d="M10.6 5.6h2.8"/><path d="M10.8 18.3h2.4"/>',
  ticket:
    '<path d="M3.5 9V7.4a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1V9a3 3 0 0 0 0 6v1.6a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V15a3 3 0 0 0 0-6z"/><path d="M14.2 6.4v11.2"/>',
  shirt:
    '<path d="M8.6 3.2 4 5.6l1.4 4 2-.6V20.4a.6.6 0 0 0 .6.6h8a.6.6 0 0 0 .6-.6V9l2 .6 1.4-4-4.6-2.4a3.6 3.6 0 0 1-6.8 0z"/>',

  // Chrome
  logo:
    '<path d="M12 21.5V12.6"/><path d="M12 12.6c0-4.3 3.1-7.7 9.3-8.1.5 4.6-1.8 9.5-9.3 8.1z"/><path d="M12 16.6C11.3 13.4 8.7 10.9 3.4 10.5c-.4 3.6 1.4 7.4 7 6.4z"/>',
  chevron:
    '<path d="M9 5.5 15.5 12 9 18.5"/>',
};

/**
 * Returns SVG markup for `name`.
 *
 * Decorative by default: an icon sitting beside its own visible label is
 * hidden from assistive tech so the label is not read twice. Pass a `title`
 * only when the icon is the sole carrier of meaning.
 */
export function icon(name, { size = 20, title = null, className = '' } = {}) {
  const path = PATHS[name];
  if (!path) return '';

  const classes = ['ico', className].filter(Boolean).join(' ');
  const a11y = title
    ? `role="img" aria-label="${String(title).replace(/"/g, '&quot;')}"`
    : 'aria-hidden="true"';

  return (
    `<svg class="${classes}" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="1.6" ` +
    `stroke-linecap="round" stroke-linejoin="round" ${a11y}>${path}</svg>`
  );
}

export const ICON_NAMES = Object.keys(PATHS);
