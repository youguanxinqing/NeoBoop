// User-configurable highlight palette.
//
// The preset colours used by the "Highlight" action are editable in Preferences
// (max 6). They live in localStorage — same-origin shared, so the preferences
// window writes and the main window reads the latest set on demand (no event
// needed: the highlight engine reads getPaletteColors() at assignment time).
//
// Colours are stored as #rrggbb. The in-text mark uses a translucent WASH of the
// colour (hexToWash) so syntax-coloured text stays readable on top in both
// light and dark; the Preferences swatches show the solid colour.

const KEY = "iw-palette";

/** Hard cap on preset colours the user may configure. */
export const MAX_COLORS = 6;

/** Default presets (used until the user customises them). */
export const DEFAULT_COLORS = [
  "#5fb0e0",
  "#8fd44e",
  "#e8c14a",
  "#e86a6a",
  "#c07ce8",
  "#6a8cf0",
];

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Current preset colours: the user's set, or the defaults. Always 1..MAX_COLORS. */
export function getPaletteColors(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const colors = parsed.filter((c): c is string => typeof c === "string" && HEX.test(c)).slice(0, MAX_COLORS);
        if (colors.length) return colors;
      }
    }
  } catch {
    // Malformed storage — fall through to defaults.
  }
  return [...DEFAULT_COLORS];
}

/** Persist the preset colours, clamped to 1..MAX_COLORS valid #rrggbb values. */
export function setPaletteColors(colors: string[]): void {
  const clean = colors.filter((c) => HEX.test(c)).slice(0, MAX_COLORS);
  localStorage.setItem(KEY, JSON.stringify(clean.length ? clean : DEFAULT_COLORS));
}

/** A translucent version of a #rrggbb colour, for the in-text highlight mark. */
export function hexToWash(hex: string, alpha = 0.42): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
