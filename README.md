# Manulife Quiz (Trắc nghiệm tương tác)

Self-hosted, Kahoot-style quiz with Manulife branding, built for Toàn's training
classes. No subscription, no per-player limits, no third party holding the
questions. Everything runs from this folder.

## What it does
- Host screen (laptop, projected): 4-digit PIN + QR code, live player list,
  big question, countdown, answer counts on reveal, leaderboard, final podium.
- Player screens (their phones): join with PIN, 4 coloured answer buttons,
  speed scoring (600 to 1000 points plus a streak bonus), own result and rank.
- VI/EN toggle on every screen (`?lang=vi|en`, remembers the choice).
- Manulife Visual System styling: white surfaces, 1px borders, flat 6px buttons,
  navy hero blocks, brand colours for the answers, real Manulife logo, embedded
  Manulife JH Sans.

## Run it
```powershell
powershell -File "C:\Users\Laptop K1\Documents\ManulifeQuiz\_serve_quiz.ps1"
```
1. It starts `node server.js` on :8002 and a cloudflared quick tunnel.
2. Read the tunnel URL it prints (also in `%TEMP%\cf_tunnel8002.err`).
3. You open that URL, press "Tạo phiên mới", show the PIN + QR to the room.
4. Players open the same URL (or scan the QR) and type their name.

Same Wi-Fi alternative (no tunnel): `http://<your-pc-ip>:8002` for everyone.
Stop: close the `node` process and `taskkill /IM cloudflared.exe /F` (only the
one targeting 8002; the dash tunnel on 8873 must stay).

## Your questions
Edit `questions.json`, then start a new session (the server reads it when a
session is created, so refresh the host page after editing):

```json
{
  "q": "Câu hỏi bằng tiếng Việt",
  "qEn": "Question in English (optional)",
  "a": ["lựa chọn 1", "lựa chọn 2", "lựa chọn 3", "lựa chọn 4"],
  "aEn": ["option 1", "option 2", "option 3", "option 4 (optional, all 4)"],
  "correct": 0,
  "time": 20
}
```
`correct` is the index 0 to 3. `time` is optional seconds for that one question
(overrides the host's per-session setting). The 8 questions currently in there
are a working sample (Manulife general knowledge plus one funnel question from
your own material). Replace them with your class content.

## Files
- `index.html` the whole UI (host + player + landing, single file, no CDN).
- `server.js` state machine + SSE push + poll fallback + QR endpoint.
- `questions.json` your quiz content.
- `_verify_quiz.cjs` static checks: syntax, no external requests, brand fonts,
  logo, font-size floors, no em-dash/emoji, DOM contract.
- `test_quiz.cjs` end-to-end: host + 2 players through all 8 questions,
  auto-reveal, scoring, leaderboard, podium, restart, EN toggle, the
  answer-leak check, 320px overflow, screenshots into `shots/`.
- `_embed_fonts.cjs` re-embeds the JH Sans subsets (idempotent).
- `_serve_quiz.ps1` server + tunnel launcher.

```bash
node _verify_quiz.cjs   # static suite
node test_quiz.cjs      # full browser run
```

Test environment note: on this machine a Chrome instance with **2 or more pages**
wedges CDP (the first `Runtime.callFunctionOn` never returns and the suite hangs).
`test_quiz.cjs` therefore launches ONE browser per page; `_probe3.cjs` is the
bisect that proved it and `_probe4.cjs` the workaround proof. If a future suite
hangs right after `page.goto` on a multi-page setup, that is why.

## Brand assets
- Logo: extracted from `Documents/ManulifeRecruitGame/_manulife_logo_source.svg`
  (green mark, black wordmark). Header uses the standard lockup, favicon is the
  white mark on a `#00A651` tile.
- Fonts: subsets in `Documents/ManulifeRecruitGame/_manulife_jhsans/`, embedded
  as base64 woff2 (weights 400/600/700). Proprietary, licensed for company
  materials: keep it internal, do not redistribute the font files.

## Scope note
Built for Toàn's own training classes and internal sessions. The Manulife logo
and JH Sans are the company's brand assets, so treat the output as internal
material, not something to publish as official Manulife content.
