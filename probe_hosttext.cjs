'use strict';
/* probe_hosttext.cjs — regression probe for: host screen answer tiles showed ONLY a
 * shape during the live question phase (text was gated behind `reveal`).
 * Drives a real host session, starts Q1, and asserts each .hAns carries its answer
 * text BEFORE reveal, and that the count badge is still hidden until reveal.
 * Run: node probe_hosttext.cjs
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const PORT = 8016;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = path.join(__dirname, 'shots');
const Q = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')).questions[0];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; let fail = 0;
function ok(name, cond, detail) {
  results.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  if (!cond) fail++;
}
function get(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej);
  });
}
async function waitHealth(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await get(BASE + '/api/health')).status === 200) return true; } catch (e) {}
    await sleep(200);
  }
  return false;
}

let srv;   // function scope, so the .catch below can reach it
(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS);
  srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname, env: Object.assign({}, process.env, { QUIZ_PORT: String(PORT) }), stdio: 'ignore'
  });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    if (!await waitHealth(15000)) throw new Error('server never became healthy');

    // Isolated contexts: the app stashes its session in localStorage, so a shared
    // profile makes the host's session leak into the player page and skip the join form.
    const hostCtx = await browser.createBrowserContext();
    const playCtx = await browser.createBrowserContext();

    const host = await hostCtx.newPage();
    await host.setViewport({ width: 1280, height: 900 });
    await host.goto(BASE + '/?lang=vi', { waitUntil: 'networkidle2' });

    await host.click('#btnHostNew');
    await host.waitForSelector('#pinBig', { timeout: 10000 });
    const pin = (await host.$eval('#pinBig', e => e.textContent)).trim();
    ok('host got a PIN', /^\d{4}$/.test(pin), pin);

    // a player joins so start is meaningful
    const player = await playCtx.newPage();
    await player.setViewport({ width: 390, height: 844 });
    await player.goto(BASE + '/?pin=' + pin + '&lang=vi', { waitUntil: 'networkidle2' });
    await player.type('#inName', 'Probe');
    await player.click('#btnJoin');
    // lobby first: the player only gets .pAns after the HOST starts the question
    await player.waitForSelector('#waitTxt', { timeout: 10000 });
    ok('player joined and is in the lobby', true);

    await host.click('#btnStart');
    await player.waitForSelector('.pAns', { timeout: 10000 });
    await host.waitForSelector('.hAns', { timeout: 10000 });
    await sleep(600);

    // ---- THE BUG: answer text must be visible during the live question ----
    const during = await host.$$eval('.hAns', els => els.map(e => ({
      text: (e.querySelector('.ansTxt') || {}).textContent || '',
      hasCnt: !!e.querySelector('.cnt'),
      h: Math.round(e.getBoundingClientRect().height)
    })));
    ok('4 host tiles rendered', during.length === 4, during.length);
    during.forEach((c, i) => {
      const expect = Q.a[i];
      ok(`Q1 tile ${i} shows its answer text during question`,
         c.text.trim() === expect && c.text.trim().length > 0, { got: c.text, expect });
      ok(`Q1 tile ${i} count badge still hidden during question`, c.hasCnt === false, c.hasCnt);
      ok(`Q1 tile ${i} has real height (not collapsed)`, c.h > 60, c.h);
    });
    ok('no tile is empty during question', during.every(c => c.text.trim().length > 0), during.map(c => c.text));

    await host.screenshot({ path: path.join(SHOTS, 'hosttext_question.png') });

    // ---- reveal: text stays, count appears ----
    await host.click('#btnClose');
    await host.waitForFunction(() => document.querySelectorAll('.hAns .cnt').length > 0, { timeout: 8000 });
    const rev = await host.$$eval('.hAns', els => els.map(e => ({
      text: (e.querySelector('.ansTxt') || {}).textContent || '',
      cnt: (e.querySelector('.cnt') || {}).textContent || '',
      ok: e.classList.contains('ok')
    })));
    rev.forEach((c, i) => {
      ok(`reveal tile ${i} keeps answer text`, c.text.trim() === Q.a[i], c);
      ok(`reveal tile ${i} now shows a count`, /^\d+$/.test(c.cnt), c.cnt);
    });
    ok('exactly one tile marked correct', rev.filter(c => c.ok).length === 1, rev.map(c => c.ok));
    ok('correct tile index matches questions.json', rev[Q.correct] && rev[Q.correct].ok, { correct: Q.correct });
    await host.screenshot({ path: path.join(SHOTS, 'hosttext_reveal.png') });

    // ---- EN round-trip (fresh context: a stored session hides the landing view) ----
    if (Q.aEn) {
      const enCtx = await browser.createBrowserContext();
      const enHost = await enCtx.newPage();
      await enHost.setViewport({ width: 1280, height: 900 });
      await enHost.goto(BASE + '/?lang=en', { waitUntil: 'networkidle2' });
      await enHost.click('#btnHostNew');
      await enHost.waitForSelector('#pinBig', { timeout: 10000 });
      const enPin = (await enHost.$eval('#pinBig', e => e.textContent)).trim();

      const enPlayCtx = await browser.createBrowserContext();
      const ep = await enPlayCtx.newPage();
      await ep.goto(BASE + '/?pin=' + enPin + '&lang=en', { waitUntil: 'networkidle2' });
      await ep.type('#inName', 'EnProbe');
      await ep.click('#btnJoin');
      await ep.waitForSelector('#waitTxt', { timeout: 10000 });

      await enHost.click('#btnStart');
      await enHost.waitForSelector('.hAns .ansTxt', { timeout: 10000 });
      await sleep(500);
      const en = await enHost.$$eval('.hAns .ansTxt', els => els.map(e => e.textContent.trim()));
      ok('EN host tiles show English text during question',
         en.length === 4 && en[0] === Q.aEn[0], { en, expect: Q.aEn });
      await enHost.screenshot({ path: path.join(SHOTS, 'hosttext_en.png') });
    }
  } finally {
    await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(results.join('\n'));
  console.log('\n' + (fail ? fail + ' FAIL' : 'ALL PASS') + ' (' + results.length + ' checks)');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE ERROR:', e.message); srv.kill(); process.exit(2); });
