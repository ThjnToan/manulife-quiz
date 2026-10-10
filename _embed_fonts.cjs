'use strict';
/* _embed_fonts.cjs — (re)embed Manulife JH Sans subsets into index.html as base64 @font-face.
 * Idempotent: rewrites the block between FONTS_BEGIN/FONTS_END markers.
 * Source subsets: Documents/ManulifeRecruitGame/_manulife_jhsans/*.woff2 (Latin+Vietnamese).
 * To re-subset after new glyphs enter the copy, see skill references/brand-font-embedding.md.
 */
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, 'index.html');
const SRC = process.env.JHSANS_DIR || 'C:/Users/Laptop K1/Documents/ManulifeRecruitGame/_manulife_jhsans';
const FACES = [
  [400, 'jh-regular.woff2'],
  [600, 'jh-demibold.woff2'],
  [700, 'jh-bold.woff2']
];

let css = '';
for (const [weight, file] of FACES) {
  const buf = fs.readFileSync(path.join(SRC, file));
  const magic = buf.slice(0, 4).toString('ascii');
  if (magic !== 'wOF2') throw new Error(`${file}: bad magic ${JSON.stringify(magic)} (not a woff2)`);
  css += `@font-face{font-family:'Manulife JH Sans';font-style:normal;font-weight:${weight};font-style:normal;font-display:swap;src:url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2')}\n`;
}

let src = fs.readFileSync(HTML, 'utf8');
const BEGIN = '/*FONTS_BEGIN*/';
const END = '/*FONTS_END*/';
const block = `${BEGIN}\n${css}${END}`;

if (src.includes(BEGIN)) {
  const re = /\/\*FONTS_BEGIN\*\/[\s\S]*?\/\*FONTS_END\*\//;
  if (!re.test(src)) throw new Error('BEGIN marker without END marker');
  src = src.replace(re, block);
} else if (src.includes('/*FONTS*/')) {
  src = src.replace('/*FONTS*/', block);
} else if (src.includes('@font-face')) {
  console.log('FONTS_ALREADY ' + (src.match(/@font-face/g) || []).length);
  process.exit(0);
} else {
  throw new Error('no font injection point found in index.html');
}

fs.writeFileSync(HTML, src);
const out = fs.readFileSync(HTML, 'utf8');
const faces = (out.match(/@font-face/g) || []).length;
if (faces !== 3) throw new Error(`expected 3 @font-face, got ${faces}`);
if (out.includes('/*FONTS*/')) throw new Error('raw marker still present');
console.log(`FONTS_EMBEDDED faces=${faces} html_chars=${out.length}`);
