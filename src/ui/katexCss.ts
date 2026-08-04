/**
 * KaTeX stylesheet for chrome / reader iframes.
 * Fonts resolve from jsDelivr CDN (same approach as sticky notes).
 * Raw CSS is a generated TS string (src/ui/katexCssRaw.ts) so Node tests
 * and the esbuild XPI bundle both load without .css loader quirks.
 */

import katexCssRaw from "./katexCssRaw";

const KATEX_FONT_CDN = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/fonts/";

/** Full KaTeX CSS with font URLs rewritten for offline-bundled CSS text. */
export function getKatexCss(): string {
  const raw = String(katexCssRaw || "");
  if (!raw) return "/* katex css missing */\n";
  return raw.replace(/url\((?:\.\/)?fonts\//g, `url(${KATEX_FONT_CDN}`);
}
