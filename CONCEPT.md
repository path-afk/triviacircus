# Analyst Trivia — Project Concept
*Started: 2026-10-15 23:27 EDT by Jay*
*Status: Scaffolding*

## What We're Building
A real-time multiplayer trivia platform where sharp people compete anonymously under pseudonyms.
Differentiated from TriviaRoyale by **analyst-tier question quality** — questions that reward
genuine understanding of markets, geopolitics, science, technology, and history.

## Core Mechanic (TriviaRoyale-style)
- All players in a room receive the same question simultaneously
- First correct answer wins that round
- Speed bonus: answer in under 5s → 1.5x multiplier
- 10 questions per game, 20 seconds each
- Live leaderboard visible throughout

## Pseudonym System
- Pick a handle → play immediately (no email required)
- Optional account registration to persist score/rank
- ELO-style rating across games
- Weekly leaderboard, category leaderboards

## Question Philosophy
NOT: "What year did X happen?"
YES: "Which sovereign wealth fund controls the most infrastructure assets globally?"
YES: "What mechanism does Rust use to guarantee memory safety without GC?"
YES: "Which geopolitical theory predicted the 2014 Crimea annexation most accurately?"

Categories:
1. Geopolitics & International Relations
2. Markets, Finance & Economics  
3. Technology & Engineering
4. Science & Nature
5. History (deep cuts, causation focus)
6. Culture & Ideas

## Stack
- **Frontend:** Next.js 14 + Tailwind CSS
- **Real-time:** Socket.io (rooms, question broadcast, answer race)
- **Backend/DB:** Supabase (Postgres, Auth, Realtime)
- **Hosting:** Netlify or Vercel
- **Question bank:** AI-curated JSON, seeded by Jay + TC

## Build Phases
### Phase 1 — Playable MVP (2-3 days)
- [ ] Next.js scaffold + Socket.io server
- [ ] Pseudonym entry → room join
- [ ] Question broadcast + answer submission
- [ ] Speed scoring + round results
- [ ] End-of-game leaderboard
- [ ] 50 seed questions (5 per category)

### Phase 2 — Accounts + Persistence (3-5 days)  
- [ ] Supabase auth (email or anonymous)
- [ ] Persistent scores + ELO rating
- [ ] Global and weekly leaderboards
- [ ] Category filtering

### Phase 3 — Polish + Scale (1 week)
- [ ] Private rooms for friends
- [ ] 500+ question bank
- [ ] Question difficulty ratings
- [ ] Mobile-responsive
- [ ] Public launch

## TC Notes (for TC to fill in)
*TC — Patrick wants us to co-build this. Your call on:*
- *Question curation approach: should we co-generate questions via prompting or each own categories?*
- *Any backend preference different from Supabase?*  
- *What's your read on the Socket.io vs Supabase Realtime tradeoff for the race mechanic?*
- *Want to own the question bank pipeline while Jay owns the game engine?*

## Patrick Notes
- Wants it to feel genuinely fun, not another enterprise tool
- "Analyst" level — questions that make you feel smart for knowing the answer
- Anonymous pseudonyms, no real names required
- Points system that rewards knowledge + speed
