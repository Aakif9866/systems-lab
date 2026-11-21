// WCAG 2.x contrast check for every token used as text, against page and control surfaces,
// in both themes (black default and the white toggle).
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const block = (selector) => {
  const start = css.indexOf(selector + " {");
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  return css.slice(start, css.indexOf("}", start));
};
const tokens = (src) => Object.fromEntries([...src.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const dark = tokens(block(":root"));
const themes = { black: dark, white: { ...dark, ...tokens(block(':root[data-theme="light"]')) } };
let failed = 0;
for (const [name, tok] of Object.entries(themes)) {
  const text = ["text", "heading", "muted", "accent", "error", ...Object.keys(tok).filter((k) => k.startsWith("h-"))];
  let worst = Infinity;
  for (const bg of ["bg", "surface", "surface-2"]) {
    for (const fg of text) {
      const r = ratio(tok[fg], tok[bg]);
      worst = Math.min(worst, r);
      if (r < 4.5) {
        failed++;
        console.log(`FAIL [${name}] ${fg} on ${bg} ${r.toFixed(2)}:1`);
      }
    }
  }
  console.log(`${name}: ${text.length} text tokens × 3 surfaces, worst ${worst.toFixed(2)}:1 · dim (decoration only) ${ratio(tok.dim, tok.bg).toFixed(2)}:1`);
}
if (failed) {
  console.error(`${failed} pair(s) below WCAG AA 4.5:1`);
  process.exit(1);
}
console.log("all text tokens pass WCAG AA in both themes");
