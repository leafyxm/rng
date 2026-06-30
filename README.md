# Blackjack Online

Real-time multiplayer blackjack with 4-letter room codes, built with Express + native WebSockets (`ws`). Built to replace Fortune Roll at leafyrng.com on Railway.

## How it works

- One player clicks **Create Room**, gets a 4-letter code, shares it.
- The other player enters the code under **Join Room**.
- Cards are dealt, players take turns (Hit/Stand) against a shared dealer, server pushes state instantly to both browsers — no polling, no refresh.
- Dealer auto-plays at 17, results (Win/Lose/Push) are computed server-side, then **Play Again** deals a fresh round.
- Game state lives in server memory per room — rooms clean themselves up ~30s after both players disconnect.

## Run locally

```
npm install
npm start
```

Visit `http://localhost:3000`. Open it in two browser tabs/windows to test both players.

## Replacing Fortune Roll on Railway

Since this fully replaces Fortune Roll on leafyrng.com, the cleanest path:

1. **Back up Fortune Roll first** (optional but recommended) — tag the current commit or push it to a separate branch, in case you want to revisit it later:
   ```
   git checkout -b fortune-roll-archive
   git push origin fortune-roll-archive
   git checkout main
   ```

2. **Clear out the old project files** in your repo (keep `.git`), then copy everything from this folder in:
   ```
   server.js
   package.json
   public/
   .gitignore
   ```

3. **Commit and push:**
   ```
   git add -A
   git commit -m "Replace Fortune Roll with Blackjack Online"
   git push origin main
   ```

4. Railway will auto-redeploy from the push (same as it did for Fortune Roll). No new environment variables are needed — the app reads `PORT` from `process.env.PORT`, which Railway sets automatically.

5. Your existing custom domain (leafyrng.com) stays pointed at the same Railway service, so it'll just start serving the new game once the deploy finishes.

## Notes

- No database — everything is in-memory, which is fine for a small dice/card game with friends. If you want rooms to survive a server restart, that'd need a small persistence layer (e.g. Railway's Postgres or Redis add-on) — happy to add that if you run into it.
- All game logic (deck, dealing, win/loss) is server-authoritative in `server.js`, so there's no way for a client to cheat by editing the page.
