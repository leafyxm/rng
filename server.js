const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Simple hash ──────────────────────────────────────────────────────────────
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

let uidSeq = 0;
function newId() { return (++uidSeq).toString(36) + Date.now().toString(36); }

// ── In-memory store ──────────────────────────────────────────────────────────
const users    = {};   // username -> user
const sessions = {};   // token -> username
const clients  = {};   // username -> ws

// ── Shop catalogue ───────────────────────────────────────────────────────────
const SHOP = {
  luck_boost:   { id:'luck_boost',   name:'Lucky Charm',      desc:'Win chance +10% per level',        baseCost:50,   maxLevel:5,  costMult:2.2 },
  roll_speed:   { id:'roll_speed',   name:'Quick Hands',      desc:'Roll cooldown -20% per level',     baseCost:80,   maxLevel:5,  costMult:2.0 },
  auto_roll:    { id:'auto_roll',    name:'Auto Roller',      desc:'Rolls automatically every N secs', baseCost:200,  maxLevel:5,  costMult:2.5 },
  afk_income:   { id:'afk_income',   name:'AFK Farmer',       desc:'+2 pts/min while offline per lvl', baseCost:150,  maxLevel:5,  costMult:2.3 },
  jackpot_boost:{ id:'jackpot_boost',name:'Fortune\'s Eye',   desc:'Jackpot pts +15 per level',        baseCost:120,  maxLevel:5,  costMult:2.4 },
  curse:        { id:'curse',        name:'Hex Token',        desc:'Reduce a friend\'s luck for 5 min',baseCost:300,  maxLevel:null,costMult:1   },
  shield:       { id:'shield',       name:'Luck Shield',      desc:'Block one incoming curse',          baseCost:250,  maxLevel:null,costMult:1   },
  profile_badge:{ id:'profile_badge',name:'Gold Badge',       desc:'Show off a gold badge on profile', baseCost:500,  maxLevel:null,costMult:1   },
  xp_boost:     { id:'xp_boost',     name:'XP Surge',         desc:'Double XP for 10 minutes',         baseCost:180,  maxLevel:null,costMult:1   },
};

function itemCost(item, currentLevel) {
  if (!item.maxLevel) return item.baseCost;
  return Math.floor(item.baseCost * Math.pow(item.costMult, currentLevel));
}

// ── User factory ─────────────────────────────────────────────────────────────
function makeUser(username, password) {
  return {
    username, passwordHash: simpleHash(password),
    displayName: username,
    bio: '',
    avatarColor: ['#7c6af7','#3dd68c','#f0614a','#f5c842','#60b4f5','#ff69b4'][Object.keys(users).length % 6],
    avatarEmoji: '🎲',
    score: 0, points: 0, totalEarned: 0,
    wins: 0, losses: 0, streak: 0, bestStreak: 0,
    totalRolls: 0, jackpots: 0,
    xp: 0, level: 1,
    history: [],
    friends: [],          // accepted friends
    friendRequests: [],   // incoming pending
    sentRequests: [],     // outgoing pending
    upgrades: {           // id -> level
      luck_boost: 0, roll_speed: 0, auto_roll: 0,
      afk_income: 0, jackpot_boost: 0
    },
    inventory: [],        // consumables: {id, qty}
    activeCurses: [],     // { from, expiresAt }
    activeShield: false,
    activeBadge: false,
    activeXpBoost: false,
    lastSeen: Date.now(),
    createdAt: Date.now(),
  };
}

function publicUser(u) {
  return {
    username: u.username, displayName: u.displayName, bio: u.bio,
    avatarColor: u.avatarColor, avatarEmoji: u.avatarEmoji,
    score: u.score, points: u.points, totalEarned: u.totalEarned,
    wins: u.wins, losses: u.losses, streak: u.streak, bestStreak: u.bestStreak,
    totalRolls: u.totalRolls, jackpots: u.jackpots,
    xp: u.xp, level: u.level,
    history: u.history.slice(0,30),
    friends: u.friends,
    friendRequests: u.friendRequests,
    sentRequests: u.sentRequests,
    upgrades: u.upgrades,
    inventory: u.inventory,
    activeCurses: u.activeCurses.filter(c => c.expiresAt > Date.now()),
    activeShield: u.activeShield,
    activeBadge: u.activeBadge,
    activeXpBoost: u.activeXpBoost,
    online: !!clients[u.username],
  };
}

function getLeaderboard() {
  return Object.values(users)
    .sort((a,b) => b.score - a.score)
    .slice(0,20)
    .map((u,i) => ({
      rank: i+1, username: u.username, displayName: u.displayName,
      score: u.score, wins: u.wins, level: u.level,
      avatarColor: u.avatarColor, avatarEmoji: u.avatarEmoji,
      activeBadge: u.activeBadge,
      online: !!clients[u.username]
    }));
}

function send(ws, event, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ event, data }));
}

function broadcast(event, data, exclude=null) {
  for (const [uname, ws] of Object.entries(clients)) {
    if (uname !== exclude) send(ws, event, data);
  }
}

function sendToUser(username, event, data) {
  if (clients[username]) send(clients[username], event, data);
}

function onlineCount() { return Object.keys(clients).length; }

// ── AFK income ticker ────────────────────────────────────────────────────────
setInterval(() => {
  for (const u of Object.values(users)) {
    if (clients[u.username]) continue; // only offline
    const lvl = u.upgrades.afk_income || 0;
    if (!lvl) continue;
    const gain = lvl * 2;
    u.points += gain;
    u.score += gain;
    u.totalEarned += gain;
  }
}, 60000);

// ── Curse expiry cleaner ─────────────────────────────────────────────────────
setInterval(() => {
  for (const u of Object.values(users)) {
    const before = u.activeCurses.length;
    u.activeCurses = u.activeCurses.filter(c => c.expiresAt > Date.now());
    if (u.activeCurses.length !== before) {
      sendToUser(u.username, 'curse_expired', { user: publicUser(u) });
    }
  }
}, 10000);

// ── Auth endpoints ────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok:false, error:'Username and password required' });
  const u = username.trim().toLowerCase();
  if (u.length < 2 || u.length > 20) return res.json({ ok:false, error:'Username must be 2–20 chars' });
  if (!/^[a-z0-9_]+$/.test(u)) return res.json({ ok:false, error:'Letters, numbers, underscores only' });
  if (users[u]) return res.json({ ok:false, error:'Username taken' });
  users[u] = makeUser(u, password);
  const token = newId();
  sessions[token] = u;
  res.json({ ok:true, token, user: publicUser(users[u]) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = username?.trim().toLowerCase();
  const user = users[u];
  if (!user || user.passwordHash !== simpleHash(password))
    return res.json({ ok:false, error:'Wrong username or password' });
  const token = newId();
  sessions[token] = u;
  res.json({ ok:true, token, user: publicUser(user) });
});

app.get('/api/leaderboard', (_req, res) => res.json(getLeaderboard()));
app.get('/api/shop', (_req, res) => res.json(SHOP));

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let username = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, data = {} } = msg;

    // ── Auth ──
    if (type === 'auth') {
      const u = sessions[data.token];
      if (!u) { send(ws,'auth_fail',{}); return; }
      username = u;
      clients[username] = ws;
      const user = users[username];
      // AFK income catch-up (max 24h)
      const lvl = user.upgrades.afk_income || 0;
      if (lvl && user.lastSeen) {
        const offlineMins = Math.min((Date.now() - user.lastSeen) / 60000, 1440);
        const gain = Math.floor(offlineMins * lvl * 2);
        if (gain > 0) {
          user.points += gain; user.score += gain; user.totalEarned += gain;
          send(ws,'afk_income',{ gain, minutes: Math.floor(offlineMins) });
        }
      }
      send(ws,'authed',{
        user: publicUser(user),
        leaderboard: getLeaderboard(),
        shop: SHOP,
        online: onlineCount()
      });
      broadcast('player_online',{ username, online: onlineCount() }, username);
      return;
    }

    if (!username || !users[username]) return;
    const user = users[username];

    // ── Roll ──
    if (type === 'roll') {
      // apply cooldown based on roll_speed upgrade
      const speedLvl = user.upgrades.roll_speed || 0;
      const cooldown = Math.max(500, 2000 - speedLvl * 300);
      if (user._lastRoll && Date.now() - user._lastRoll < cooldown) {
        send(ws,'roll_denied',{ cooldown }); return;
      }
      user._lastRoll = Date.now();

      // luck calc
      const luckLvl = user.upgrades.luck_boost || 0;
      const cursed = user.activeCurses.some(c => c.expiresAt > Date.now());
      const luckBonus = luckLvl * 0.10 - (cursed ? 0.20 : 0);
      const rand = Math.random() - luckBonus;

      let val, pts, resultType;
      if (rand < 0.1667) { val=6; pts=30+(user.upgrades.jackpot_boost||0)*15; resultType='jackpot'; user.wins++; user.streak++; user.jackpots++; }
      else if (rand < 0.50) { val=Math.random()<0.5?5:4; pts=10; resultType='win'; user.wins++; user.streak++; }
      else { val=Math.floor(Math.random()*3)+1; pts=-5; resultType='loss'; user.losses++; user.streak=0; }

      user.bestStreak = Math.max(user.bestStreak, user.streak);
      user.totalRolls++;

      // XP
      const xpGain = resultType==='jackpot'?30:resultType==='win'?10:2;
      const xpMult = user.activeXpBoost ? 2 : 1;
      user.xp += xpGain * xpMult;
      const newLevel = Math.floor(1 + Math.sqrt(user.xp / 50));
      const leveledUp = newLevel > user.level;
      user.level = newLevel;

      if (pts > 0) { user.score += pts; user.points += pts; user.totalEarned += pts; }
      else { user.score = Math.max(0, user.score + pts); user.points = Math.max(0, user.points + pts); }

      user.history.unshift({ val, type: resultType, pts: pts>0?`+${pts}`:`${pts}`, t: new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) });
      if (user.history.length > 30) user.history.pop();

      send(ws,'roll_result',{ val, resultType, pts, leveledUp, newLevel, user: publicUser(user) });
      broadcast('score_update',{ username, displayName: user.displayName, score: user.score, resultType, val }, username);
      broadcast('leaderboard', getLeaderboard());
    }

    // ── Shop: buy upgrade ──
    if (type === 'buy') {
      const itemId = data.itemId;
      const item = SHOP[itemId];
      if (!item) return;

      // consumables
      if (!item.maxLevel) {
        const cost = item.baseCost;
        if (user.points < cost) { send(ws,'buy_fail',{ error:'Not enough points' }); return; }
        user.points -= cost;
        const existing = user.inventory.find(i=>i.id===itemId);
        if (existing) existing.qty++;
        else user.inventory.push({ id:itemId, qty:1 });
        send(ws,'buy_ok',{ itemId, user: publicUser(user) });
        return;
      }

      // upgrades
      const currentLvl = user.upgrades[itemId] || 0;
      if (currentLvl >= item.maxLevel) { send(ws,'buy_fail',{ error:'Already max level' }); return; }
      const cost = itemCost(item, currentLvl);
      if (user.points < cost) { send(ws,'buy_fail',{ error:'Not enough points' }); return; }
      user.points -= cost;
      user.upgrades[itemId] = currentLvl + 1;
      send(ws,'buy_ok',{ itemId, newLevel: user.upgrades[itemId], user: publicUser(user) });
    }

    // ── Use consumable ──
    if (type === 'use_item') {
      const { itemId, targetUsername } = data;
      const inv = user.inventory.find(i=>i.id===itemId);
      if (!inv || inv.qty < 1) { send(ws,'use_fail',{ error:'You don\'t have that item' }); return; }

      if (itemId === 'curse') {
        const target = users[targetUsername];
        if (!target) { send(ws,'use_fail',{ error:'Player not found' }); return; }
        if (!user.friends.includes(targetUsername)) { send(ws,'use_fail',{ error:'Can only curse friends' }); return; }
        if (target.activeShield) {
          target.activeShield = false;
          sendToUser(targetUsername,'shield_used',{ from: username, user: publicUser(target) });
          send(ws,'use_ok',{ message:'Their shield blocked your curse!' });
        } else {
          target.activeCurses.push({ from: username, expiresAt: Date.now() + 5*60*1000 });
          sendToUser(targetUsername,'cursed',{ from: username, user: publicUser(target) });
          send(ws,'use_ok',{ message:`Cursed ${target.displayName} for 5 minutes!` });
        }
        inv.qty--;
        if (inv.qty<=0) user.inventory = user.inventory.filter(i=>i.id!==itemId);
        send(ws,'inventory_update',{ user: publicUser(user) });
      }

      if (itemId === 'shield') {
        user.activeShield = true;
        inv.qty--;
        if (inv.qty<=0) user.inventory = user.inventory.filter(i=>i.id!==itemId);
        send(ws,'use_ok',{ message:'Shield active — next curse will be blocked!', user: publicUser(user) });
      }

      if (itemId === 'profile_badge') {
        user.activeBadge = true;
        inv.qty--;
        if (inv.qty<=0) user.inventory = user.inventory.filter(i=>i.id!==itemId);
        send(ws,'use_ok',{ message:'Gold badge activated on your profile!', user: publicUser(user) });
        broadcast('leaderboard', getLeaderboard());
      }

      if (itemId === 'xp_boost') {
        user.activeXpBoost = true;
        setTimeout(() => { user.activeXpBoost = false; sendToUser(username,'xp_boost_ended',{ user: publicUser(user) }); }, 10*60*1000);
        inv.qty--;
        if (inv.qty<=0) user.inventory = user.inventory.filter(i=>i.id!==itemId);
        send(ws,'use_ok',{ message:'Double XP active for 10 minutes!', user: publicUser(user) });
      }
    }

    // ── Friend request ──
    if (type === 'friend_request') {
      const target = users[data.username?.toLowerCase()];
      if (!target) { send(ws,'friend_error',{ error:'Player not found' }); return; }
      if (target.username === username) { send(ws,'friend_error',{ error:"That's you!" }); return; }
      if (user.friends.includes(target.username)) { send(ws,'friend_error',{ error:'Already friends' }); return; }
      if (user.sentRequests.includes(target.username)) { send(ws,'friend_error',{ error:'Request already sent' }); return; }
      if (target.sentRequests.includes(username)) {
        // they already sent us one — auto accept
        acceptFriend(username, target.username);
        return;
      }
      user.sentRequests.push(target.username);
      target.friendRequests.push(username);
      send(ws,'friend_request_sent',{ to: target.username, user: publicUser(user) });
      sendToUser(target.username,'friend_request_received',{ from: username, fromDisplay: user.displayName, user: publicUser(target) });
    }

    if (type === 'accept_friend') {
      acceptFriend(username, data.username?.toLowerCase());
    }

    if (type === 'decline_friend') {
      const from = data.username?.toLowerCase();
      user.friendRequests = user.friendRequests.filter(r=>r!==from);
      if (users[from]) users[from].sentRequests = users[from].sentRequests.filter(r=>r!==username);
      send(ws,'friend_declined',{ user: publicUser(user) });
    }

    if (type === 'remove_friend') {
      const fname = data.username?.toLowerCase();
      user.friends = user.friends.filter(f=>f!==fname);
      if (users[fname]) users[fname].friends = users[fname].friends.filter(f=>f!==username);
      send(ws,'friends_update',{ user: publicUser(user) });
      sendToUser(fname,'friends_update',{ user: publicUser(users[fname]) });
    }

    // ── Profile update ──
    if (type === 'update_profile') {
      const { displayName, bio, avatarColor, avatarEmoji } = data;
      if (displayName && displayName.trim().length <= 24) user.displayName = displayName.trim();
      if (bio !== undefined && bio.length <= 120) user.bio = bio;
      if (avatarColor) user.avatarColor = avatarColor;
      if (avatarEmoji) user.avatarEmoji = avatarEmoji;
      send(ws,'profile_updated',{ user: publicUser(user) });
      broadcast('leaderboard', getLeaderboard());
    }
  });

  ws.on('close', () => {
    if (username && users[username]) {
      users[username].lastSeen = Date.now();
      delete clients[username];
      broadcast('player_offline',{ username, online: onlineCount() });
    }
  });
});

function acceptFriend(a, b) {
  const ua = users[a], ub = users[b];
  if (!ua || !ub) return;
  if (!ua.friends.includes(b)) ua.friends.push(b);
  if (!ub.friends.includes(a)) ub.friends.push(a);
  ua.friendRequests = ua.friendRequests.filter(r=>r!==b);
  ua.sentRequests   = ua.sentRequests.filter(r=>r!==b);
  ub.friendRequests = ub.friendRequests.filter(r=>r!==a);
  ub.sentRequests   = ub.sentRequests.filter(r=>r!==a);
  sendToUser(a,'friend_accepted',{ with: b, user: publicUser(ua) });
  sendToUser(b,'friend_accepted',{ with: a, user: publicUser(ub) });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Fortune Roll on http://localhost:${PORT}`));
