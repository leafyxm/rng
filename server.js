const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory DB (persists for server session)
const users = {}; // username -> { username, passwordHash, score, wins, losses, streak, bestStreak, totalRolls, jackpots, history, friends, avatarIdx, createdAt }
const sessions = {}; // token -> username
const clients = {}; // username -> ws

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

function broadcast(event, data, exclude = null) {
  const msg = JSON.stringify({ event, data });
  for (const [uname, ws] of Object.entries(clients)) {
    if (uname !== exclude && ws.readyState === 1) ws.send(msg);
  }
}

function getLeaderboard() {
  return Object.values(users)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((u, i) => ({ rank: i + 1, username: u.username, score: u.score, wins: u.wins, avatarIdx: u.avatarIdx, online: !!clients[u.username] }));
}

function getFriends(username) {
  const u = users[username];
  if (!u) return [];
  return u.friends.map(f => {
    const fr = users[f];
    if (!fr) return null;
    return { username: fr.username, score: fr.score, wins: fr.wins, avatarIdx: fr.avatarIdx, online: !!clients[fr.username] };
  }).filter(Boolean);
}

function onlineCount() {
  return Object.keys(clients).length;
}

// Auth endpoints
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: 'Username and password required' });
  const u = username.trim().toLowerCase();
  if (u.length < 2 || u.length > 20) return res.json({ ok: false, error: 'Username must be 2–20 chars' });
  if (!/^[a-z0-9_]+$/.test(u)) return res.json({ ok: false, error: 'Letters, numbers, underscores only' });
  if (users[u]) return res.json({ ok: false, error: 'Username taken' });
  users[u] = {
    username: u, passwordHash: simpleHash(password),
    score: 0, wins: 0, losses: 0, streak: 0, bestStreak: 0,
    totalRolls: 0, jackpots: 0, history: [], friends: [],
    avatarIdx: Object.keys(users).length % 6, createdAt: Date.now()
  };
  const token = uuidv4();
  sessions[token] = u;
  res.json({ ok: true, token, username: u, user: publicUser(users[u]) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = username?.trim().toLowerCase();
  const user = users[u];
  if (!user || user.passwordHash !== simpleHash(password)) return res.json({ ok: false, error: 'Wrong username or password' });
  const token = uuidv4();
  sessions[token] = u;
  res.json({ ok: true, token, username: u, user: publicUser(user) });
});

app.get('/api/leaderboard', (req, res) => res.json(getLeaderboard()));

function publicUser(u) {
  return { username: u.username, score: u.score, wins: u.wins, losses: u.losses, streak: u.streak, bestStreak: u.bestStreak, totalRolls: u.totalRolls, jackpots: u.jackpots, history: u.history.slice(0, 20), friends: u.friends, avatarIdx: u.avatarIdx };
}

// WebSocket
wss.on('connection', (ws) => {
  let username = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, data } = msg;

    if (type === 'auth') {
      const u = sessions[data.token];
      if (!u) { ws.send(JSON.stringify({ event: 'auth_fail' })); return; }
      username = u;
      clients[username] = ws;
      ws.send(JSON.stringify({ event: 'authed', data: { user: publicUser(users[username]), leaderboard: getLeaderboard(), friends: getFriends(username), online: onlineCount() } }));
      broadcast('player_online', { username, online: onlineCount() }, username);
    }

    if (!username || !users[username]) return;
    const user = users[username];

    if (type === 'roll') {
      const val = Math.floor(Math.random() * 6) + 1;
      let pts = 0, resultType;
      if (val === 6) { pts = 30; resultType = 'jackpot'; user.wins++; user.streak++; user.jackpots++; }
      else if (val >= 4) { pts = 10; resultType = 'win'; user.wins++; user.streak++; }
      else { pts = -5; resultType = 'loss'; user.losses++; user.streak = 0; }
      user.score = Math.max(0, user.score + pts);
      user.bestStreak = Math.max(user.bestStreak, user.streak);
      user.totalRolls++;
      user.history.unshift({ val, type: resultType, pts: pts > 0 ? `+${pts}` : `${pts}`, t: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
      if (user.history.length > 30) user.history.pop();

      ws.send(JSON.stringify({ event: 'roll_result', data: { val, resultType, pts, user: publicUser(user) } }));

      // Broadcast to friends and leaderboard watchers
      broadcast('score_update', { username, score: user.score, wins: user.wins, resultType, val }, username);
      broadcast('leaderboard', getLeaderboard());
    }

    if (type === 'add_friend') {
      const fname = data.username?.trim().toLowerCase();
      if (!fname || fname === username) return;
      if (!users[fname]) { ws.send(JSON.stringify({ event: 'friend_error', data: { error: 'Player not found' } })); return; }
      if (user.friends.includes(fname)) { ws.send(JSON.stringify({ event: 'friend_error', data: { error: 'Already friends' } })); return; }
      user.friends.push(fname);
      ws.send(JSON.stringify({ event: 'friends_update', data: { friends: getFriends(username) } }));
      // Notify the other user if online
      if (clients[fname]) clients[fname].send(JSON.stringify({ event: 'friend_request', data: { from: username } }));
    }

    if (type === 'remove_friend') {
      const fname = data.username?.trim().toLowerCase();
      user.friends = user.friends.filter(f => f !== fname);
      ws.send(JSON.stringify({ event: 'friends_update', data: { friends: getFriends(username) } }));
    }

    if (type === 'get_friends') {
      ws.send(JSON.stringify({ event: 'friends_update', data: { friends: getFriends(username) } }));
    }
  });

  ws.on('close', () => {
    if (username) {
      delete clients[username];
      broadcast('player_offline', { username, online: onlineCount() });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Fortune Roll running on http://localhost:${PORT}`));
