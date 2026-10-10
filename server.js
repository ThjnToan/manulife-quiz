'use strict';
/* Manulife Quiz server
 * Serves index.html + realtime game state (SSE push + 3s polling fallback).
 * Zero runtime deps except `qrcode` (used only to render the join-link QR).
 *
 * API
 *   GET  /                        -> index.html
 *   GET  /api/health              -> {ok, games}
 *   GET  /api/qr?data=<url>       -> image/svg+xml QR for that URL
 *   GET  /api/stream?pin&token    -> SSE state stream (role-filtered)
 *   GET  /api/state?pin&token     -> same payload, one shot (poll fallback)
 *   POST /api/host/new            -> {pin, token}          (host session)
 *   POST /api/join                {pin, name, token?}      -> {pin, token, name}
 *   POST /api/answer              {pin, token, c}          -> submit answer
 *   POST /api/action              {pin, token, action, ...}-> host controls
 *
 * Security rule: player payloads NEVER contain `correct` while phase=question.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const PORT = Number(process.env.QUIZ_PORT || process.env.PORT || 8002);
const QFILE = process.env.QUIZ_QUESTIONS || path.join(__dirname, 'questions.json');
const INDEX = path.join(__dirname, 'index.html');
const MAX_PLAYERS = 100;
const GAME_TTL_MS = 4 * 60 * 60 * 1000;   // idle games are swept after 4h
const MIN_DUR = 10, MAX_DUR = 90;

const games = new Map();          // pin -> game
const conns = new Map();          // pin -> Set<{res}>

const now = () => Date.now();
const tok = () => require('crypto').randomBytes(12).toString('hex');

/* ---------------------------------------------------------------- questions */
function loadQuestions() {
  const raw = JSON.parse(fs.readFileSync(QFILE, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.questions;
  if (!Array.isArray(list) || list.length === 0) throw new Error('questions.json has no questions');
  return list.map((q, i) => {
    if (!q || typeof q.q !== 'string' || !q.q.trim()) throw new Error('question ' + i + ': missing text');
    if (!Array.isArray(q.a) || q.a.length !== 4) throw new Error('question ' + i + ': needs exactly 4 options');
    const correct = q.correct;
    if (!Number.isInteger(correct) || correct < 0 || correct > 3) throw new Error('question ' + i + ': correct must be 0..3');
    return {
      q: q.q.trim(),
      qEn: (typeof q.qEn === 'string' && q.qEn.trim()) ? q.qEn.trim() : null,
      a: q.a.map(String),
      aEn: (Array.isArray(q.aEn) && q.aEn.length === 4) ? q.aEn.map(String) : null,
      correct,
      time: Number(q.time) > 0 ? Number(q.time) : 0
    };
  });
}

/* --------------------------------------------------------------------- game */
function makePin() {
  let pin;
  do { pin = String(1000 + Math.floor(Math.random() * 9000)); } while (games.has(pin));
  return pin;
}

function newGame() {
  const g = {
    pin: makePin(), hostToken: tok(),
    phase: 'lobby', qIndex: -1,
    questions: loadQuestions(),
    duration: 20,
    players: new Map(),            // token -> {name, score, streak, answers:{}}
    qStart: 0, qEnd: 0, submitted: 0,
    timer: null, touched: now()
  };
  games.set(g.pin, g);
  return g;
}

function touch(g) { g.touched = now(); }

function getGame(pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) return null;
  return games.get(pin) || null;
}

function roleOf(g, token) {
  if (typeof token === 'string' && token === g.hostToken) return 'host';
  if (typeof token === 'string' && g.players.has(token)) return 'player';
  return null;
}

function startQuestion(g) {
  const q = g.questions[g.qIndex];
  const dur = (q.time > 0 ? q.time : g.duration);
  g.phase = 'question';
  g.qStart = now();
  g.qEnd = g.qStart + dur * 1000;
  g.submitted = 0;
  clearTimeout(g.timer);
  g.timer = setTimeout(() => reveal(g), dur * 1000 + 250);
  touch(g);
  push(g);
}

function reveal(g) {
  if (g.phase !== 'question') return;
  clearTimeout(g.timer);
  g.timer = null;
  for (const p of g.players.values()) {
    if (!Object.prototype.hasOwnProperty.call(p.answers, g.qIndex)) {
      p.answers[g.qIndex] = { c: -1, ok: false, pts: 0 };
    }
  }
  g.phase = 'reveal';
  touch(g);
  push(g);
}

function answer(g, token, c) {
  if (g.phase !== 'question') return { st: 409, err: 'closed' };
  if (!Number.isInteger(c) || c < 0 || c > 3) return { st: 400, err: 'bad' };
  const p = g.players.get(token);
  if (!p) return { st: 401, err: 'player' };
  if (Object.prototype.hasOwnProperty.call(p.answers, g.qIndex)) return { st: 409, err: 'already' };
  const ts = now();
  if (ts > g.qEnd) return { st: 409, err: 'closed' };
  const q = g.questions[g.qIndex];
  const total = g.qEnd - g.qStart;
  const ratio = total > 0 ? Math.max(0, Math.min(1, (g.qEnd - ts) / total)) : 0;
  const ok = c === q.correct;
  let pts = 0;
  if (ok) {
    const streakBonus = Math.min(p.streak, 5) * 100;
    pts = 600 + Math.round(400 * ratio) + streakBonus;
    p.streak += 1;
  } else {
    p.streak = 0;
  }
  p.score += pts;
  p.answers[g.qIndex] = { c, ok, pts };
  g.submitted += 1;
  touch(g);
  return { ok: true, pts };
}

function hostAction(g, action, arg) {
  switch (action) {
    case 'duration': {
      const s = Number(arg);
      if (!(s >= MIN_DUR && s <= MAX_DUR)) return { st: 400, err: 'duration' };
      if (g.phase !== 'lobby') return { st: 409, err: 'phase' };
      g.duration = s;
      break;
    }
    case 'start': {
      if (g.phase !== 'lobby') return { st: 409, err: 'phase' };
      g.qIndex = 0;
      startQuestion(g);
      return null;                       // startQuestion already pushed
    }
    case 'close': {
      if (g.phase !== 'question') return { st: 409, err: 'phase' };
      reveal(g);
      return null;
    }
    case 'board': {
      if (g.phase !== 'reveal') return { st: 409, err: 'phase' };
      g.phase = 'board';
      break;
    }
    case 'next': {
      if (g.phase !== 'board') return { st: 409, err: 'phase' };
      if (g.qIndex + 1 >= g.questions.length) {
        g.phase = 'final';
        g.qIndex = g.questions.length - 1;
      } else {
        g.qIndex += 1;
        startQuestion(g);
        return null;
      }
      break;
    }
    case 'restart': {
      if (g.phase !== 'final' && g.phase !== 'lobby') return { st: 409, err: 'phase' };
      clearTimeout(g.timer);
      g.timer = null;
      g.phase = 'lobby';
      g.qIndex = -1;
      g.submitted = 0;
      for (const p of g.players.values()) { p.score = 0; p.streak = 0; p.answers = {}; }
      break;
    }
    default:
      return { st: 400, err: 'action' };
  }
  touch(g);
  push(g);
  return null;
}

/* --------------------------------------------------------------- state view */
/* Leaderboard rows keyed by token (internal only; tokens are stripped on send). */
function boardRows(g) {
  return [...g.players.entries()]
    .map(([token, p]) => {
      const a = p.answers[g.qIndex];
      return { token, name: p.name, score: p.score, streak: p.streak, gain: a ? a.pts : 0 };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((r, i) => ({ token: r.token, rank: i + 1, name: r.name, score: r.score, streak: r.streak, gain: r.gain }));
}

function publicRows(g, token) {
  const rows = boardRows(g);
  const idx = rows.findIndex(r => r.token === token);
  return {
    rows: rows.map(r => ({ rank: r.rank, name: r.name, score: r.score, streak: r.streak, gain: r.gain })),
    myRank: idx >= 0 ? idx + 1 : null
  };
}

function stateFor(g, role, token) {
  const base = {
    serverNow: now(), role, pin: g.pin, phase: g.phase,
    qIndex: g.qIndex, total: g.questions.length, duration: g.duration,
    count: g.players.size
  };
  const qi = g.qIndex;
  if (qi >= 0) base.qTime = g.questions[qi].time || g.duration;

  if (role === 'host') {
    const names = [...g.players.values()].map(p => p.name);
    const host = Object.assign(base, { names });
    if (qi >= 0 && (g.phase === 'question' || g.phase === 'reveal')) {
      const q = g.questions[qi];
      const counts = [0, 0, 0, 0];
      for (const p of g.players.values()) {
        const a = p.answers[qi];
        if (a && a.c >= 0) counts[a.c] += 1;
      }
      host.q = { q: q.q, qEn: q.qEn, a: q.a, aEn: q.aEn, correct: q.correct, counts };
      host.answered = g.submitted;
      host.deadline = g.phase === 'question' ? g.qEnd : null;
    }
    if (g.phase === 'board' || g.phase === 'final') host.board = publicRows(g, token).rows;
    return host;
  }

  const p = g.players.get(token);
  const me = { name: p.name, score: p.score, streak: p.streak, answered: Object.prototype.hasOwnProperty.call(p.answers, qi) };
  const out = Object.assign(base, { me });
  if (qi >= 0 && p.answers[qi]) me.last = { pts: p.answers[qi].pts, c: p.answers[qi].c };

  if (qi >= 0 && (g.phase === 'question' || g.phase === 'reveal')) {
    const q = g.questions[qi];
    // `correct` ONLY leaves the server once the question is revealed.
    out.q = {
      q: q.q, qEn: q.qEn, a: q.a, aEn: q.aEn,
      correct: g.phase === 'question' ? null : q.correct
    };
    out.deadline = g.phase === 'question' ? g.qEnd : null;
    if (g.phase === 'reveal' && p.answers[qi]) {
      const a = p.answers[qi];
      out.result = { ok: a.ok, pts: a.pts, choice: a.c, timeout: a.c < 0 };
    }
  }
  if (g.phase === 'board' || g.phase === 'final') {
    const pub = publicRows(g, token);
    out.board = pub.rows.slice(0, 10);
    out.myRank = pub.myRank;
  }
  if (g.phase === 'lobby') out.names = [...g.players.values()].map(x => x.name);
  return out;
}

/* ------------------------------------------------------------------- push */
function push(g) {
  const set = conns.get(g.pin);
  if (!set || set.size === 0) return;
  for (const c of [...set]) {
    try {
      c.res.write('data: ' + JSON.stringify(stateFor(g, c.role, c.token)) + '\n\n');
    } catch (e) {
      set.delete(c);
      try { c.res.end(); } catch (_) {}
    }
  }
}

/* --------------------------------------------------------------- http utils */
function send(res, st, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, cb) {
  let buf = '';
  req.on('data', d => {
    buf += d;
    if (buf.length > 8192) { req.destroy(); }
  });
  req.on('end', () => {
    if (!buf) return cb(null, {});
    try { cb(null, JSON.parse(buf)); } catch (e) { cb(e); }
  });
  req.on('error', cb);
}

function cleanName(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
}

/* ----------------------------------------------------------------- routes */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const q = u.searchParams;

  if (req.method === 'GET') {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      fs.readFile(INDEX, (err, buf) => {
        if (err) { res.writeHead(500); res.end('index missing'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return;
    }
    if (u.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (u.pathname === '/api/health') { send(res, 200, { ok: true, games: games.size, time: now() }); return; }
    if (u.pathname === '/api/qr') {
      const data = q.get('data') || '';
      if (!/^https?:\/\//.test(data) || data.length > 400) { send(res, 400, { ok: false, err: 'data' }); return; }
      QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
        .then(svg => {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(svg);
        })
        .catch(() => send(res, 500, { ok: false, err: 'qr' }));
      return;
    }
    if (u.pathname === '/api/state' || u.pathname === '/api/stream') {
      const g = getGame(q.get('pin'));
      const role = g ? roleOf(g, q.get('token')) : null;
      if (!g || !role) { send(res, 404, { ok: false, err: 'session' }); return; }
      touch(g);
      if (u.pathname === '/api/state') { send(res, 200, stateFor(g, role, q.get('token'))); return; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify(stateFor(g, role, q.get('token'))) + '\n\n');
      const c = { res, role, token: q.get('token') };
      if (!conns.has(g.pin)) conns.set(g.pin, new Set());
      conns.get(g.pin).add(c);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 15000);
      const drop = () => {
        clearInterval(hb);
        const set = conns.get(g.pin);
        if (set) { set.delete(c); if (set.size === 0) conns.delete(g.pin); }
      };
      req.on('close', drop);
      res.on('close', drop);
      res.on('error', drop);
      return;
    }
    send(res, 404, { ok: false, err: 'no route' });
    return;
  }

  if (req.method === 'POST') {
    readBody(req, (err, b) => {
      if (err) { send(res, 400, { ok: false, err: 'json' }); return; }

      if (u.pathname === '/api/host/new') {
        try {
          const g = newGame();
          send(res, 200, { ok: true, pin: g.pin, token: g.hostToken, total: g.questions.length, duration: g.duration });
        } catch (e) {
          send(res, 500, { ok: false, err: 'questions: ' + e.message });
        }
        return;
      }

      if (u.pathname === '/api/join') {
        const g = getGame(b.pin);
        if (!g) { send(res, 404, { ok: false, err: 'pin' }); return; }
        // Rejoin with an existing token keeps identity across refresh.
        if (typeof b.token === 'string' && g.players.has(b.token)) {
          const p = g.players.get(b.token);
          push(g);
          send(res, 200, { ok: true, pin: g.pin, token: b.token, name: p.name, rejoined: true });
          return;
        }
        if (g.phase !== 'lobby') { send(res, 409, { ok: false, err: 'started' }); return; }
        const name = cleanName(b.name);
        if (name.length < 1) { send(res, 400, { ok: false, err: 'name' }); return; }
        if (g.players.size >= MAX_PLAYERS) { send(res, 409, { ok: false, err: 'full' }); return; }
        let final = name, n = 2;
        const taken = new Set([...g.players.values()].map(p => p.name.toLowerCase()));
        while (taken.has(final.toLowerCase())) { final = name.slice(0, 13) + ' ' + n; n += 1; if (n > 20) break; }
        const token = tok();
        g.players.set(token, { name: final, score: 0, streak: 0, answers: {} });
        touch(g);
        push(g);
        send(res, 200, { ok: true, pin: g.pin, token, name: final });
        return;
      }

      if (u.pathname === '/api/answer') {
        const g = getGame(b.pin);
        if (!g) { send(res, 404, { ok: false, err: 'pin' }); return; }
        const r = answer(g, b.token, b.c);
        if (r && r.ok) push(g);
        if (r && r.ok) send(res, 200, r);
        else send(res, r ? r.st : 500, { ok: false, err: r ? r.err : 'x' });
        return;
      }

      if (u.pathname === '/api/action') {
        const g = getGame(b.pin);
        if (!g) { send(res, 404, { ok: false, err: 'pin' }); return; }
        if (roleOf(g, b.token) !== 'host') { send(res, 401, { ok: false, err: 'host' }); return; }
        const r = hostAction(g, b.action, b.seconds);
        if (r) { send(res, r.st, { ok: false, err: r.err }); return; }
        send(res, 200, { ok: true });
        return;
      }

      send(res, 404, { ok: false, err: 'no route' });
    });
    return;
  }

  send(res, 405, { ok: false, err: 'method' });
});

// SSE lives longer than Node's default request timeout: disable it.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.listen(PORT, '0.0.0.0', () => {
  console.log('manulife-quiz on :' + PORT);
});

// Idle game sweep.
setInterval(() => {
  const t = now();
  for (const [pin, g] of [...games]) {
    const busy = g.phase === 'question' || g.phase === 'reveal' || g.phase === 'board';
    if (!busy && t - g.touched > GAME_TTL_MS) {
      clearTimeout(g.timer);
      games.delete(pin);
      conns.delete(pin);
    }
  }
}, 5 * 60 * 1000);
