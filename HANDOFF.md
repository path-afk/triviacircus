# Trivia Circus — Handoff Document
*Generated: 2026-10-16T04:05:04.194Z*
*Built by: Jay (implementation) + TC (design brief, QA lane)*

## Project Overview
Real-time multiplayer trivia game. No toxic chat — accuracy-first scoring,
simultaneous reveal, four positive post-reveal reactions only.

**Domain target:** triviacircus.com (Pat's domain — not yet deployed)
**Preview:** http://127.0.0.1:3001/ (loopback only)

---

## Architecture

```
trivia-site/
├── server.js              # Express + Socket.io game engine + exports for tests
├── package.json           # express ^4.18.2, socket.io ^4.7.2
├── public/
│   ├── index.html         # Lobby/landing — pseudonym entry, Create/Join, a11y toggles
│   └── game.html          # Live game room — question, reveal, SYG, gameover
├── questions/
│   └── bank.json          # 60 original questions, 6 categories, A/B/C/D + explanation
└── tests/
    └── game.test.js       # Deterministic scoring, title, filter, question bank tests
```

**Stack:** Node.js, Express (static files), Socket.io (WebSocket/polling), no database (in-memory rooms).
Swap `rooms` Map for Redis in production for multi-process scale.

---

## Run / Test Instructions

```bash
cd /Users/koop/.openclaw/workspace/projects/trivia-site

# Install dependencies (already done)
npm install

# Run tests
node tests/game.test.js

# Start dev server (loopback only)
node server.js
# → http://127.0.0.1:3001/

# Test multiplayer: open two browser tabs
# Tab 1: http://127.0.0.1:3001/  → Create Room → note code
# Tab 2: http://127.0.0.1:3001/  → Join Room → enter code → Start from Tab 1
```

---

## Visual Design (TC spec applied)

| Token | Value | Usage |
|---|---|---|
| `--navy` | `#0f1c2e` | Page background |
| `--ivory` | `#faf6f0` | Question card background |
| `--coral` | `#ff5252` | Primary action, logo, answer buttons |
| `--teal` | `#00c9a7` | Success state, correct answers |
| `--amber` | `#ffb347` | Timer warning, Oracle/dissent, Double Down |
| `--dim` | `#7a9bb5` | Muted text, sidebar |

---

## Scoring Logic

| Event | Points |
|---|---|
| Correct answer | +100 |
| Speed bonus (within 7s grace) | +10 |
| Streak bonus | +20 per consecutive (max +100) |
| Trust Bonus (unanimous + correct) | +50 |
| Oracle Bonus (correct lone SYG dissenter) | +80 |
| Double Down correct | +50 additional |
| Double Down wrong | -50 (floor 0) |

Speed bonus is capped at 10% of base — accuracy dominates per TC brief.

---

## Features Implemented

- [x] Pseudonym entry (no account required); server cleans + filters profanity; generates name if blank
- [x] Create Room / Join Room with shareable code
- [x] Together Mode: all players answer simultaneously; reveal room split with percentages
- [x] Stand Your Ground (host-toggleable): divided rooms get 7s second-chance window
- [x] Trust Bonus for unanimous correct room
- [x] Oracle Bonus for correct lone SYG dissenter
- [x] Double Down (amber wager button)
- [x] Four post-reveal reactions only: Knew It / Lucky Guess / No Way / Rematch
- [x] No public free-text chat (server enforces allowed reaction list)
- [x] Earned titles computed from play pattern at game end
- [x] Share card text (copy to clipboard)
- [x] Host controls: Stand Your Ground toggle, Timer off, Mute reactions, Lock room, Remove player
- [x] Keyboard 1/2/3/4 and A/B/C/D answer input
- [x] 48px+ minimum button targets
- [x] Visible focus outlines (2–3px coral/teal/amber per action type)
- [x] Reduced motion: CSS media query + body.rm class toggle on lobby page
- [x] Large text toggle on lobby page
- [x] High contrast toggle on lobby page
- [x] a11y prefs persisted in localStorage
- [x] ARIA labels on all interactive elements and live regions
- [x] Screen-reader labels on answer options ("Option A: ...")
- [x] Mobile-first CSS; sidebar collapses to 130px at 580px breakpoint; answers go 1-column
- [x] Timer-off mode for private rooms (host setting)
- [x] Animated reaction feed (popIn/fadeOut)
- [x] Live answer count during question phase

---

## Question Bank

60 original questions, balanced across:
- History (10) — events, causes, consequences
- Science (10) — physics, biology, chemistry, earth science
- Geography (10) — physical, political, superlatives
- Culture (10) — art, literature, music, philosophy
- Sports (10) — rules, records, history
- Wild Card (10) — language, animals, math curiosities

Each question: id, category, difficulty (1–3), text, options {A/B/C/D}, answer (letter), explanation.
Source metadata stored in bank.json; not shown mid-game.

---

## Known Gaps / Phase 2

| Gap | Notes |
|---|---|
| No persistent accounts/ELO | Session-scoped pseudonyms only; no DB |
| Daily challenge mode | Not yet — needs cron + persistent 5-question daily set |
| Share card image | Text-only; no canvas/OG image generation |
| Rival Mode (1v1) | Designed by Jay+TC, not implemented — Phase 1b |
| User-submitted questions | Phase 3 |
| Voice host | Phase 3 |
| Rate limiting | No abuse protection on socket events |
| Redis room store | In-memory only; single-process |
| Quick Play public room | Button on lobby links to CIRCUS-PUBLIC; works as shared room |

---

## TC QA Checklist (handoff to TC)

- [ ] Verify one-handed flow: keyboard 1–4 answers all questions without mouse
- [ ] Verify reduced motion: no animations when prefers-reduced-motion or body.rm
- [ ] Verify focus order: Tab through lobby form, Create/Join, game options in sequence
- [ ] Verify host controls panel: toggle each setting, confirm emit + UI update
- [ ] Verify no-chat rule: attempt to emit custom reaction string; server should drop it
- [ ] Verify word filter: attempt profanity pseudonym; server should replace with generated name
- [ ] Verify Trust Bonus: unanimous correct room → all players +50 bonus
- [ ] Verify Oracle: lone dissenter picks correct after SYG → +80 bonus
- [ ] Screen reader: run VoiceOver on lobby and question panel; check label quality
- [ ] Mobile: test on 375px viewport; answers go single column; sidebar 130px

---

*No domain purchase. No production deployment. Local preview only.*
