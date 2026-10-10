'use strict';
/* test_quiz.cjs — end-to-end run of a full session: host + 2 players, 8 questions,
 * auto-reveal on the first question, forced close on the rest, leaderboard, podium,
 * restart, EN toggle, the no-answer-leak check, plus screenshots for vision review.
 * Run: node test_quiz.cjs
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const PORT = 8012;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = path.join(__dirname, 'shots');
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')).questions;

const results = [];
let fail = 0;
function ok(name, cond, detail) {
  results.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  if (!cond) fail++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: b }));
    }).on('error', reject);
  });
}
async function waitHealth(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await get(BASE + '/api/health'); if (r.status === 200) return true; } catch (e) {}
    await sleep(200);
  }
  throw new Error('server did not come up');
}
function watch(page, tag, errs) {
  page.on('pageerror', e => errs.push(tag + ' pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(tag + ' console: ' + m.text()); });
}
async function stateOf(page, pin, token) {
  return page.evaluate(async (p, k) => {
    const r = await fetch('/api/state?pin=' + p + '&token=' + k);
    return r.status === 200 ? r.json() : { status: r.status };
  }, pin, token);
}
async function session(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('mq_sess') || 'null'));
}

(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, env: Object.assign({}, process.env, { QUIZ_PORT: String(PORT) }), stdio: 'ignore'
  });
  let browsers = [];
  try {
    await waitHealth(15000);

    /* QR endpoint is served by our own server (no external requests) */
    const hostProbe = await get(BASE + '/api/health');
    ok('health endpoint', hostProbe.status === 200, hostProbe.status);

    /* ONE browser per page: on this box any browser with 2+ pages wedges CDP
     * (first Runtime.callFunctionOn never returns). Bisected in _probe3.cjs,
     * workaround proven in _probe4.cjs. */
    const LAUNCH = {
      executablePath: CHROME, headless: true, protocolTimeout: 45000,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
    };
    const hostB = await puppeteer.launch(LAUNCH);
    const p1B = await puppeteer.launch(LAUNCH);
    const p2B = await puppeteer.launch(LAUNCH);
    browsers = [hostB, p1B, p2B];
    console.log('STEP browsers launched');
    const errs = [];
    const host = await hostB.newPage();
    const p1 = await p1B.newPage();
    const p2 = await p2B.newPage();
    console.log('STEP pages created');
    watch(host, 'host', errs); watch(p1, 'p1', errs); watch(p2, 'p2', errs);
    await host.setViewport({ width: 1280, height: 900 });
    await p1.setViewport({ width: 360, height: 740, deviceScaleFactor: 2 });
    await p2.setViewport({ width: 360, height: 740, deviceScaleFactor: 2 });
    console.log('STEP viewports set');

    /* ---- host creates a session ---- */
    await host.goto(BASE + '/', { waitUntil: 'load' });
    console.log('STEP host page loaded');
    const fontOk = await host.evaluate(async () => {
      await document.fonts.ready;
      return {
        loaded: document.fonts.check('16px "Manulife JH Sans"'),
        faces: document.fonts.size
      };
    });
    ok('JH Sans actually renders (fonts.check)', fontOk.loaded === true, fontOk);
    ok('exactly 3 font faces declared', fontOk.faces === 3, fontOk.faces);
    await host.click('#btnHostNew');
    await host.waitForSelector('#pinBig', { timeout: 8000 });
    console.log('STEP host session created');
    const pin = (await host.$eval('#pinBig', e => e.textContent)).trim();
    ok('PIN is 4 digits', /^\d{4}$/.test(pin), pin);
    const qrSrc = await host.$eval('#qrImg', e => e.getAttribute('src'));
    const qr = await get(BASE + qrSrc.replace('/api/qr', '/api/qr'));
    ok('QR served as svg by own server', qr.status === 200 && /image\/svg/.test(qr.type) && qr.body.includes('<svg'), { st: qr.status, type: qr.type });
    ok('QR encodes join url with pin', decodeURIComponent(qrSrc).includes('/?pin=' + pin), qrSrc);
    await host.screenshot({ path: path.join(SHOTS, 'host_lobby.png') });

    /* ---- players join via ?pin= prefill ---- */
    for (const [page, name] of [[p1, 'Bao'], [p2, 'My']]) {
      await page.goto(BASE + '/?pin=' + pin, { waitUntil: 'load' });
      const prefill = await page.$eval('#inPin', e => e.value);
      ok(name + ' PIN prefilled from url', prefill === pin, prefill);
      await page.type('#inName', name);
      await page.click('#btnJoin');
      await page.waitForSelector('#myName', { timeout: 8000 });
      const shown = await page.$eval('#myName', e => e.textContent.trim());
      ok(name + ' in lobby with own name', shown === name, shown);
    }
    await host.waitForFunction(() => {
      const el = document.querySelector('#lobbyCount');
      return el && el.textContent.trim() === '2';
    }, { timeout: 8000 });
    const names = await host.$$eval('#lobbyNames .chipName', els => els.map(e => e.textContent));
    ok('host lobby lists both players', names.includes('Bao') && names.includes('My'), names);

    await host.select('#selDur', '10');
    await sleep(150);
    await host.click('#btnStart');
    await host.waitForSelector('#qText', { timeout: 8000 });
    await p1.waitForSelector('#pqText', { timeout: 8000 });
    await p2.waitForSelector('#pqText', { timeout: 8000 });
    const hostQ1 = await host.$eval('#qText', e => e.textContent.trim());
    const p1Q1 = await p1.$eval('#pqText', e => e.textContent.trim());
    ok('host shows the question text', hostQ1 === QUESTIONS[0].q, hostQ1);
    ok('player sees the question text', p1Q1 === QUESTIONS[0].q, p1Q1);
    /* the answer grid is pinned to the bottom for thumb reach; it must still
     * sit entirely above the fold BEFORE any answer is locked in */
    const gridFold = await p1.evaluate(() => {
      const g = document.querySelector('#pGrid').getBoundingClientRect();
      return Math.round(g.bottom - window.innerHeight);
    });
    ok('answer grid fully above the fold (unlocked)', gridFold <= 0, 'overflow px: ' + gridFold);

    /* ---- leak checks during question 1 ---- */
    const s1 = await session(p1);
    const st1 = await stateOf(p1, s1.pin, s1.token);
    ok('player state has no correct index during question', st1.q && (st1.q.correct === null || st1.q.correct === undefined), st1.q && st1.q.correct);
    ok('player state never serialises a number under q.correct', !/"correct":\s*\d/.test(JSON.stringify(st1.q)), JSON.stringify(st1.q).slice(0, 120));
    const hostOkDuringQ = await host.$$eval('.hAns.ok', els => els.length);
    const hostCntDuringQ = await host.$$eval('.hAns .cnt', els => els.length);
    ok('host screen marks no answer during question', hostOkDuringQ === 0, hostOkDuringQ);
    ok('host screen shows no counts during question', hostCntDuringQ === 0, hostCntDuringQ);

    /* ---- 320px overflow probe on the player page ---- */
    await p1.setViewport({ width: 320, height: 740, deviceScaleFactor: 2 });
    await sleep(200);
    const ov = await p1.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok('no horizontal overflow at 320px', ov <= 0, ov);
    await p1.setViewport({ width: 360, height: 740, deviceScaleFactor: 2 });
    await sleep(150);

    const c0 = QUESTIONS[0].correct;
    await p1.click('.pAns[data-i="' + c0 + '"]');
    await p2.click('.pAns[data-i="' + ((c0 + 1) % 4) + '"]');
    await p1.waitForSelector('#locked', { timeout: 5000 });
    await p2.waitForSelector('#locked', { timeout: 5000 });
    await p1.screenshot({ path: path.join(SHOTS, 'player_locked.png') });
    await host.screenshot({ path: path.join(SHOTS, 'host_question.png') });

    /* ---- question 1 reveals on its own when the timer runs out ---- */
    await host.waitForSelector('#btnBoard', { timeout: 14000 });
    ok('auto-reveal after 10s timer', true, '');
    const counts = await host.$$eval('.hAns .cnt', els => els.map(e => Number(e.textContent)));
    ok('reveal counts total 2', counts.reduce((a, b) => a + b, 0) === 2, counts);
    ok('reveal count on correct answer is 1', counts[c0] === 1, counts);
    const hostOkReveal = await host.$$eval('.hAns.ok', els => els.length);
    ok('host marks exactly one correct cell', hostOkReveal === 1, hostOkReveal);
    await p1.waitForSelector('#resBadge', { timeout: 5000 });
    const r1 = await p1.evaluate(() => ({
      badge: document.querySelector('#resBadge').textContent.trim(),
      pts: document.querySelector('#resPts').textContent.trim(),
      corr: document.querySelector('#resCorrect').textContent.trim()
    }));
    ok('p1 sees CORRECT with points', r1.badge === 'ĐÚNG' && /^\+\d+/.test(r1.pts), r1);
    ok('p1 sees the correct answer text', r1.corr.includes(QUESTIONS[0].a[c0]), r1.corr);
    await p2.waitForSelector('#resBadge', { timeout: 5000 });
    const r2 = await p2.$eval('#resBadge', e => e.textContent.trim());
    ok('p2 sees WRONG', r2 === 'SAI', r2);
    await p1.screenshot({ path: path.join(SHOTS, 'player_reveal.png') });
    await host.screenshot({ path: path.join(SHOTS, 'host_reveal.png') });

    /* ---- leaderboard after question 1 ---- */
    await host.click('#btnBoard');
    await host.waitForSelector('#boardRows .brow', { timeout: 5000 });
    const board1 = await host.$$eval('#boardRows .brow', els => els.map(e => ({
      name: e.querySelector('.nm').textContent.trim(),
      score: Number(e.querySelector('.sc').textContent),
      gain: e.querySelector('.gn').textContent.trim()
    })));
    ok('leaderboard has 2 rows', board1.length === 2, board1);
    ok('p1 leads after a correct answer', board1[0].name === 'Bao' && board1[0].gain.startsWith('+') && board1[0].score > 0, board1);
    ok('p2 on zero', board1[1].name === 'My' && board1[1].score === 0, board1);
    await host.screenshot({ path: path.join(SHOTS, 'host_board.png') });

    /* ---- questions 2..N: answer both, force close, board, next ---- */
    for (let qi = 1; qi < QUESTIONS.length; qi++) {
      await host.click('#btnNext');
      await p1.waitForSelector('#pqText', { timeout: 8000 });
      await p2.waitForSelector('#pqText', { timeout: 8000 });
      const c = QUESTIONS[qi].correct;
      await p1.click('.pAns[data-i="' + c + '"]');
      await p2.click('.pAns[data-i="' + ((c + 1) % 4) + '"]');
      await p1.waitForSelector('#locked', { timeout: 5000 });
      await p2.waitForSelector('#locked', { timeout: 5000 });
      await host.click('#btnClose');
      await host.waitForSelector('#btnBoard', { timeout: 6000 });
      await p1.waitForSelector('#resBadge', { timeout: 6000 });
      if (qi === QUESTIONS.length - 1) {
        await p1.screenshot({ path: path.join(SHOTS, 'player_question_late.png') });
      }
      await host.click('#btnBoard');
      await host.waitForSelector('#boardRows .brow', { timeout: 5000 });
    }
    ok('all ' + QUESTIONS.length + ' questions played', true, '');

    /* ---- final podium ---- */
    await host.click('#btnNext');
    await host.waitForSelector('#podium', { timeout: 6000 });
    const podium = await host.$eval('#podium .p1 .nm', e => e.textContent.trim());
    ok('podium first place is the perfect scorer', podium === 'Bao', podium);
    const finalRows = await host.$$eval('#finalRows .brow', els => els.map(e => ({
      name: e.querySelector('.nm').textContent.trim(), score: Number(e.querySelector('.sc').textContent)
    })));
    ok('final scores: p1 clearly ahead', finalRows[0].name === 'Bao' && finalRows[0].score > finalRows[1].score, finalRows);
    /* 8 correct answers: speed points 600 to 1000 each, plus streak bonuses
     * 0+100+200+300+400+500+500+500 = 2500 (a perfect run never breaks the streak) */
    const lo = 8 * 600 + 2500, hi = 8 * 1000 + 2500;
    ok('perfect run scored in the expected band', finalRows[0].score >= lo && finalRows[0].score <= hi,
      finalRows[0].score + ' not in [' + lo + ',' + hi + ']');
    await host.screenshot({ path: path.join(SHOTS, 'host_final.png') });
    await p2.waitForSelector('#pFinal', { timeout: 6000 });
    const p2rank = await p2.$eval('.rankLine.big', e => e.textContent.trim());
    ok('p2 sees own rank #2', p2rank.endsWith('#2'), p2rank);
    await p1.screenshot({ path: path.join(SHOTS, 'player_final.png') });

    /* ---- EN toggle ---- */
    await p2.click('#langEN');
    await sleep(150);
    const topEn = await p2.$eval('#topName', e => e.textContent.trim());
    const waitEn = await p2.$eval('.heroSub, .hint', e => e.textContent.trim());
    ok('player EN toggle switches chrome', topEn === 'Interactive quiz', topEn);
    await p2.click('#langVI');
    await p2.click('#langEN');
    await host.click('#langEN');
    await sleep(150);
    const hostTopEn = await host.$eval('#topName', e => e.textContent.trim());
    const restartBtnEn = await host.$eval('#btnRestart', e => e.textContent.trim());
    ok('host EN toggle switches chrome', hostTopEn === 'Interactive quiz' && restartBtnEn === 'Play again', { hostTopEn, restartBtnEn });
    await host.click('#langVI');
    await p2.click('#langVI');
    await p1.click('#langVI');

    /* ---- restart: back to lobby, scores wiped, players kept ---- */
    await host.click('#btnRestart');
    await host.waitForSelector('#pinBig', { timeout: 6000 });
    const afterRestart = await stateOf(p1, s1.pin, s1.token);
    ok('restart returns to lobby', afterRestart.phase === 'lobby', afterRestart.phase);
    ok('restart resets scores', afterRestart.me.score === 0, afterRestart.me.score);
    ok('players survive restart', afterRestart.count === 2, afterRestart.count);

    /* ---- EN question text on a fresh round, then a clean close ---- */
    await p1.click('#langEN');
    await host.click('#btnStart');
    await p1.waitForSelector('#pqText', { timeout: 8000 });
    const enQ = await p1.$eval('#pqText', e => e.textContent.trim());
    ok('player EN shows translated question', enQ === QUESTIONS[0].qEn, enQ);
    await p1.click('#langVI');
    await p1.screenshot({ path: path.join(SHOTS, 'player_question.png') });
    await p1.click('.pAns[data-i="' + QUESTIONS[0].correct + '"]');
    await p1.waitForSelector('#locked', { timeout: 5000 });
    await host.click('#btnClose');
    await host.waitForSelector('#btnBoard', { timeout: 6000 });

    ok('zero page/console errors', errs.length === 0, errs.slice(0, 6));
  } catch (e) {
    ok('run completed without exception', false, e.message);
  } finally {
    for (const b of browsers) { try { await b.close(); } catch (e) {} }
    try { srv.kill(); } catch (e) {}
  }
  console.log(results.join('\n'));
  console.log('\n' + (fail ? fail + ' FAILED' : 'ALL ' + results.length + ' CHECKS PASSED'));
  process.exit(fail ? 1 : 0);
})();
