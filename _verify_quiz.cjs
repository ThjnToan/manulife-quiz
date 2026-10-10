'use strict';
/* _verify_quiz.cjs — static checks for index.html / server.js / questions.json.
 * Run: node _verify_quiz.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
const serve = fs.readFileSync(path.join(dir, '_serve_quiz.ps1'), 'utf8');
const qraw = fs.readFileSync(path.join(dir, 'questions.json'), 'utf8');
const questions = JSON.parse(qraw);
const qList = Array.isArray(questions) ? questions : questions.questions;

const results = [];
let fail = 0;
function ck(name, cond, detail) {
  results.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '  -> ' + detail));
  if (!cond) fail++;
}

/* 1. JS syntax of every inline script */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ck('inline script count >= 1', scripts.length >= 1, scripts.length);
scripts.forEach((s, i) => {
  try { new vm.Script(s, { filename: 'inline' + i }); ck('script[' + i + '] compiles', true, ''); }
  catch (e) { ck('script[' + i + '] compiles', false, e.message); }
});
try { new vm.Script(server, { filename: 'server.js' }); ck('server.js compiles', true, ''); }
catch (e) { ck('server.js compiles', false, e.message); }

/* 2. No em-dash (U+2014) and no en-dash (U+2013) anywhere in written artifacts */
for (const [label, txt] of [['index.html', html], ['server.js', server], ['README.md', readme], ['questions.json', qraw], ['_serve_quiz.ps1', serve]]) {
  const has2014 = txt.indexOf('\u2014') >= 0;
  const has2013 = txt.indexOf('\u2013') >= 0;
  ck(label + ': no em/en dash', !has2014 && !has2013, 'U+2014=' + has2014 + ' U+2013=' + has2013);
}

/* 3. No emoji (check rendered body text + server + questions; head holds base64 fonts) */
const body = html.slice(html.indexOf('<body'));
const emojiRe = /[\u{1F000}-\u{1FFFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2600}-\u{26FF}]/u;
ck('index body: no emoji', !emojiRe.test(body), (body.match(emojiRe) || [''])[0]);
ck('server.js: no emoji', !emojiRe.test(server), (server.match(emojiRe) || [''])[0]);
ck('questions.json: no emoji', !emojiRe.test(qraw), (qraw.match(emojiRe) || [''])[0]);

/* 4. Self-contained: no external src/href, no CDN, no @import */
const attrs = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map(m => m[1]);
const badAttrs = attrs.filter(a => !/^(data:|\/|#|mailto:)/.test(a));
ck('no external src/href', badAttrs.length === 0, JSON.stringify(badAttrs));
const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
ck('no @import in CSS', !/@import/.test(style), 'found');
ck('no CDN hostnames', !/cdn\.|unpkg|jsdelivr|googleapis|gstatic|cloudflare.*font/i.test(html), 'found');

/* 5. Known COP bug guard: favicon needs the data:image/svg+xml prefix */
const icon = (html.match(/<link rel="icon" href="([^"]{0,60})/) || [])[1] || '';
ck('favicon data URI prefix', icon.startsWith('data:image/svg+xml,'), icon.slice(0, 40));

/* 6. Brand fonts embedded correctly */
const faces = (html.match(/@font-face/g) || []).length;
ck('3 @font-face blocks', faces === 3, faces);
ck('font-synthesis:none', /font-synthesis:\s*none/.test(style), 'missing');
ck('JH Sans first in body stack', /font-family:\s*'Manulife JH Sans'/.test(style), 'missing');
ck('woff2 magic embedded', (html.match(/base64,d09GMg/g) || []).length >= 1, 'no wOF2 base64 head found');

/* 7. Font-size floor (>= 12.5px, includes clamp args) */
let minFs = 999, minAt = '';
for (const m of style.matchAll(/font-size:\s*([^;"}]+)/g)) {
  for (const n of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) {
    const v = parseFloat(n[1]);
    if (v < minFs) { minFs = v; minAt = m[0].slice(0, 40); }
  }
}
ck('font-size floor >= 12.5px', minFs >= 12.5, 'min=' + minFs + ' at ' + minAt);

/* 8. House style: flat, no big radii, no gradients/shadows */
let maxR = 0;
for (const m of style.matchAll(/border-radius:\s*(\d+)px/g)) maxR = Math.max(maxR, Number(m[1]));
ck('border-radius <= 12px', maxR <= 12, 'max=' + maxR);
ck('no gradients', !/linear-gradient|radial-gradient/i.test(style), 'found');
ck('no box-shadow', !/box-shadow/i.test(style), 'found');

/* 9. Real logo: 11 paths, 3 green mark paths */
const logoBlock = (html.match(/<svg class="mlogo"[\s\S]*?<\/svg>/) || [''])[0];
const pathCount = (logoBlock.match(/<path /g) || []).length;
const greenCount = (logoBlock.match(/fill="#00ac5b"/g) || []).length;
ck('logo lockup 11 paths', pathCount === 11, pathCount);
ck('logo mark 3 green paths', greenCount === 3, greenCount);

/* 10. i18n accessor pitfalls */
ck('no DICT[wrong][lang] accessor', !/\bDICT\[\w+\]\[/.test(html), 'found');
ck('no TX. table (pitfall)', !/\bTX\./.test(html), 'found');
ck('DICT has vi + en', /vi:\s*\{/.test(html) && /en:\s*\{/.test(html), 'missing');
ck('key copy exists in both dictionaries', ['joinTitle', 'startBtn', 'boardTitle', 'finalTitle', 'correct', 'wrong']
  .every(k => (html.match(new RegExp('\\b' + k + ':', 'g')) || []).length === 2),
  'a key is not defined twice (vi+en)');

/* 11. App posture: never says game / AI (body text only) */
ck('body never says game', !/\bgame\b/i.test(body), 'found');
ck('body never says AI', !/\bAI\b/.test(body), 'found');
/* the UI carries the rule; server internals may name their own data structures */
ck('README never frames it as a game', !/\bgame\b/i.test(readme), 'found');

/* 12. DOM contract used by test_quiz.cjs */
const needIds = ['inPin', 'inName', 'btnJoin', 'btnHostNew', 'pinBig', 'qrImg', 'joinUrl', 'lobbyCount',
  'lobbyNames', 'selDur', 'btnStart', 'qNum', 'qText', 'answeredNum', 'timerNum', 'timerBar', 'btnClose',
  'btnBoard', 'boardRows', 'btnNext', 'podium', 'finalRows', 'btnRestart', 'myName', 'waitTxt', 'pqText',
  'pGrid', 'resBadge', 'resPts', 'resCorrect', 'pBoard', 'myRank', 'pFinal', 'toast', 'net', 'topName',
  'pinChip', 'langVI', 'langEN'];
const missingIds = needIds.filter(id => !html.includes('id="' + id + '"'));
ck('DOM contract ids present', missingIds.length === 0, JSON.stringify(missingIds));

/* 13. server.js: dependencies and long-lived SSE config */
const reqs = [...server.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]);
const allowed = ['http', 'fs', 'path', 'crypto', 'qrcode'];
const badReq = reqs.filter(r => !allowed.includes(r));
ck('server requires only allowed modules', badReq.length === 0, JSON.stringify(badReq) + ' vs ' + JSON.stringify(reqs));
ck('server disables requestTimeout for SSE', /server\.requestTimeout\s*=\s*0/.test(server), 'missing');
ck('server binds 0.0.0.0 (LAN play)', /listen\(PORT,\s*'0\.0\.0\.0'/.test(server), 'missing');
ck('player payload hides correct while question', /correct: g\.phase === 'question' \? null : q\.correct/.test(server), 'missing');

/* 14. questions.json sanity */
ck('questions >= 3', Array.isArray(qList) && qList.length >= 3, Array.isArray(qList) ? qList.length : 'not array');
ck('every question has 4 options + valid correct',
  Array.isArray(qList) && qList.every((q, i) => Array.isArray(q.a) && q.a.length === 4 &&
    Number.isInteger(q.correct) && q.correct >= 0 && q.correct <= 3 && typeof q.q === 'string' && q.q.length > 0),
  'bad question');
ck('EN mirrors well formed (aEn omitted or all 4)', Array.isArray(qList) && qList.every(q =>
  (q.aEn === undefined || q.aEn === null || (Array.isArray(q.aEn) && q.aEn.length === 4)) &&
  (q.aEn === undefined || q.aEn === null || q.aEn.length === q.a.length)),
  'aEn shape wrong');

console.log(results.join('\n'));
console.log('\n' + (fail ? fail + ' FAILED' : 'ALL ' + results.length + ' CHECKS PASSED'));
process.exit(fail ? 1 : 0);
