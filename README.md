# Fortune Roll — Multiplayer Dice Game

Real-time multiplayer dice game with accounts, friends, live leaderboard, and WebSocket updates.

## Run locally

```bash
npm install
node server.js
# Open http://localhost:3000
```

## Deploy (free options)

### Railway (easiest — 1 click)
1. Push to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Done — Railway auto-detects Node.js

### Render
1. Push to GitHub
2. render.com → New Web Service → connect repo
3. Build: `npm install`, Start: `node server.js`

### Fly.io
```bash
npm install -g flyctl
fly launch
fly deploy
```

## Notes
- Data is in-memory — restarting the server resets all accounts/scores
- For persistence, swap the `users` object for a SQLite or Postgres DB
