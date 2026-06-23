const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h.toString(36);
}
let uidSeq = 0;
function newId() { return (++uidSeq).toString(36) + Date.now().toString(36); }

// ── Persistence ───────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data.json');
function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      // Support old format (plain users object) and new format ({users, sessions})
      if (raw.users) return raw;
      return { users: raw, sessions: {} };
    }
  } catch(e) { console.error('DB load error:', e.message); }
  return { users: {}, sessions: {} };
}
function saveDB() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify({users, sessions}), 'utf8'); }
  catch(e) { console.error('DB save error:', e.message); }
}
setInterval(saveDB, 10000);
process.on('SIGTERM', () => { saveDB(); process.exit(0); });
process.on('SIGINT',  () => { saveDB(); process.exit(0); });

// ── Store ─────────────────────────────────────────────────────────────────────
const _db      = loadDB();
const users    = _db.users || {};
const sessions = _db.sessions || {};
const clients  = {};

// ── Roguelike config ──────────────────────────────────────────────────────────
const ROOMS_PER_FLOOR = 3;
const FLOORS_PER_RUN  = 7;
const BOSS_FLOOR      = 7;

const ROOM_TYPES = ['normal','normal','normal','elite','treasure','curse_shrine','blessing','shop_room'];
const EVENTS = [
  { id:'devil_deal',   name:"Devil's Deal",    desc:'Lose 15 HP, gain 60 gold.',       effect:{ hp:-15, gold:60 } },
  { id:'ancient_rune', name:'Ancient Rune',    desc:'Sacrifice 30 gold, gain a relic.',effect:{ gold:-30, relic:true } },
  { id:'fountain',     name:'Healing Fountain',desc:'Restore 20 HP.',                  effect:{ hp:20 } },
  { id:'gamble',       name:'Cursed Gamble',   desc:'Roll d6: 1-3 lose 20 gold, 4-6 gain 40 gold.', effect:{ gamble:true } },
  { id:'merchant',     name:'Wandering Merchant',desc:'Buy one random upgrade for 25 gold.', effect:{ deal:true } },
];

const RELICS = [
  { id:'lucky_coin',   name:'Lucky Coin',    desc:'+15% base win chance',       effect:'luck+15' },
  { id:'iron_dice',    name:'Iron Dice',     desc:'Never lose HP on miss',      effect:'no_miss_hp' },
  { id:'golden_chalice',name:'Golden Chalice',desc:'Jackpots give +20 extra gold',effect:'jackpot_gold+20' },
  { id:'vampiric_orb', name:'Vampiric Orb',  desc:'Win = +3 HP',                effect:'win_heal+3' },
  { id:'cursed_mirror',name:'Cursed Mirror', desc:'Misses deal damage but give +5 gold', effect:'miss_gold+5' },
  { id:'hourglass',    name:'Hourglass',     desc:'Every 5th roll is guaranteed win', effect:'every5win' },
  { id:'phoenix_feather',name:'Phoenix Feather',desc:'Once per run, survive at 0 HP with 1 HP',effect:'revive' },
  { id:'crystal_ball', name:'Crystal Ball',  desc:'See next roll result before rolling', effect:'preview' },
  { id:'gamblers_token',name:"Gambler's Token",desc:'Streaks give bonus gold: +5 per streak level',effect:'streak_gold' },
  { id:'void_shard',   name:'Void Shard',    desc:'Jackpot on 5 or 6',          effect:'jackpot56' },
];

const META_UPGRADES = [
  { id:'start_hp',     name:'Sturdy Constitution', desc:'Start each run with +10 max HP',  cost:100, maxLevel:5 },
  { id:'start_gold',   name:'Coin Purse',           desc:'Start each run with +15 gold',    cost:80,  maxLevel:5 },
  { id:'luck_passive', name:'Born Lucky',            desc:'+5% win chance permanently',      cost:120, maxLevel:3 },
  { id:'relic_slot',   name:'Relic Pouch',           desc:'Start with 1 extra relic slot',   cost:200, maxLevel:2 },
  { id:'floor_reward', name:'Treasure Hunter',       desc:'+10 gold on every floor clear',   cost:150, maxLevel:3 },
  { id:'shop_discount',name:'Haggler',               desc:'Shop prices -10% per level',      cost:90,  maxLevel:3 },
  { id:'hp_regen',     name:'Regeneration',          desc:'+2 HP restored between floors',   cost:160, maxLevel:3 },
];

const RUN_UPGRADES = [
  { id:'reroll',       name:'Reroll',        desc:'Reroll the dice once per room',   weight:3 },
  { id:'double_or_nothing',name:'Double or Nothing',desc:'Win=x2 gold, Loss=-10 HP',weight:2 },
  { id:'shield_roll',  name:'Shield Roll',   desc:'Next miss does not damage HP',    weight:3 },
  { id:'gold_magnet',  name:'Gold Magnet',   desc:'+5 gold on every win',            weight:3 },
  { id:'berserker',    name:'Berserker',     desc:'Each consecutive win +2 bonus gold', weight:2 },
  { id:'lucky_streak', name:'Lucky Streak',  desc:'Streak 3+ = extra roll per room', weight:2 },
  { id:'glass_cannon', name:'Glass Cannon',  desc:'Jackpot=+50 gold, but misses deal +5 extra dmg', weight:1 },
  { id:'meditate',     name:'Meditate',      desc:'Before rolling, may skip for +8 gold', weight:2 },
  { id:'bloodlust',    name:'Bloodlust',     desc:'Each win heals 2 HP',             weight:2 },
  { id:'cursed_blessing',name:'Cursed Blessing',desc:'+20% luck but lose 10 max HP', weight:1 },
];

const BOSSES = [
  { id:'the_void',     name:'The Void',      desc:'All 4s count as misses. Win on 5-6 only.', hpMod:1.5, goldMod:2 },
  { id:'iron_judge',   name:'The Iron Judge',desc:'You must win 3 times before 2 losses or the run ends.', hpMod:1.2, goldMod:2.5 },
  { id:'fortune_god',  name:'Fortune God',   desc:'Roll 5 times. Majority wins = victory. Majority losses = -40 HP.', hpMod:1, goldMod:3 },
];

function randomFrom(arr) { return arr[Math.floor(Math.random()*arr.length)]; }
function weightedRandom(arr) {
  const total = arr.reduce((s,i)=>s+(i.weight||1),0);
  let r = Math.random()*total;
  for (const item of arr) { r-=(item.weight||1); if(r<=0) return item; }
  return arr[arr.length-1];
}

function makeUser(username, password) {
  return {
    username, passwordHash: simpleHash(password),
    displayName: username, bio: '', avatarColor: '#7c6af7', avatarEmoji: '🎲',
    // Meta (persistent)
    gold: 0, totalGoldEarned: 0,
    bestRunScore: 0, bestRunFloor: 0, totalRuns: 0, totalWins: 0,
    xp: 0, level: 1,
    metaUpgrades: {},   // id -> level
    friends: [], friendRequests: [], sentRequests: [],
    inventory: [],      // consumables
    activeBadge: false,
    lastSeen: Date.now(), createdAt: Date.now(),
    // Active run (null if not in run)
    run: null,
  };
}

function publicUser(u) {
  return {
    username: u.username, displayName: u.displayName, bio: u.bio,
    avatarColor: u.avatarColor, avatarEmoji: u.avatarEmoji,
    gold: u.gold, totalGoldEarned: u.totalGoldEarned,
    bestRunScore: u.bestRunScore, bestRunFloor: u.bestRunFloor,
    totalRuns: u.totalRuns, totalWins: u.totalWins,
    xp: u.xp, level: u.level, metaUpgrades: u.metaUpgrades,
    friends: u.friends, friendRequests: u.friendRequests, sentRequests: u.sentRequests,
    inventory: u.inventory, activeBadge: u.activeBadge,
    run: u.run,
    online: !!clients[u.username],
  };
}

function getLeaderboard() {
  return Object.values(users).sort((a,b)=>b.bestRunScore-a.bestRunScore).slice(0,20).map((u,i)=>({
    rank:i+1, username:u.username, displayName:u.displayName,
    bestRunScore:u.bestRunScore, bestRunFloor:u.bestRunFloor,
    totalRuns:u.totalRuns, level:u.level,
    avatarColor:u.avatarColor, avatarEmoji:u.avatarEmoji,
    activeBadge:u.activeBadge, online:!!clients[u.username],
  }));
}

function send(ws,event,data){ if(ws&&ws.readyState===1) ws.send(JSON.stringify({event,data})); }
function broadcast(event,data,exclude=null){ for(const[u,w]of Object.entries(clients)) if(u!==exclude) send(w,event,data); }
function sendTo(username,event,data){ if(clients[username]) send(clients[username],event,data); }
function onlineCount(){ return Object.keys(clients).length; }

// ── Run factory ───────────────────────────────────────────────────────────────
function startRun(user) {
  const metaHP  = (user.metaUpgrades.start_hp||0)*10;
  const metaGold= (user.metaUpgrades.start_gold||0)*15;
  const metaLuck= (user.metaUpgrades.luck_passive||0)*5;
  user.run = {
    active: true,
    floor: 1, room: 0,
    hp: 80 + metaHP, maxHp: 80 + metaHP,
    gold: 20 + metaGold,
    score: 0,
    streak: 0,
    relics: [],
    upgrades: [],   // run upgrades chosen
    rollsThisRoom: 0,
    winsThisRoom:  0,
    lossesThisRoom:0,
    shieldUsed: false,
    rerollUsed: false,
    skipUsed: false,
    rollsUntilGuarantee: 5,
    reviveUsed: false,
    roomType: 'normal',
    roomCleared: false,
    currentEvent: null,
    currentBoss: null,
    path: generatePath(),
    metaLuckBonus: metaLuck,
    upgradeChoices: null,
    relicChoices: null,
    previewNext: null,
    doubleOrNothing: false,
    bossState: null,
  };
  advanceRoom(user);
}

function generatePath() {
  const path = [];
  for (let f=1;f<=FLOORS_PER_RUN;f++) {
    if (f===BOSS_FLOOR) { path.push(['boss']); continue; }
    const rooms = [];
    for (let r=0;r<ROOMS_PER_FLOOR;r++) {
      if (r===0) rooms.push('normal');
      else rooms.push(randomFrom(ROOM_TYPES));
    }
    path.push(rooms);
  }
  return path;
}

function advanceRoom(user) {
  const run = user.run;
  run.roomCleared = false;
  run.rollsThisRoom = 0;
  run.winsThisRoom = 0;
  run.lossesThisRoom = 0;
  run.shieldUsed = false;
  run.rerollUsed = false;
  run.skipUsed = false;
  run.upgradeChoices = null;
  run.relicChoices = null;
  run.currentEvent = null;
  run.currentBoss = null;
  run.bossState = null;
  run.previewNext = null;

  const floorIdx = run.floor - 1;
  const roomIdx  = run.room;

  if (run.floor > FLOORS_PER_RUN) { endRun(user, true); return; }

  if (run.floor === BOSS_FLOOR) {
    run.roomType = 'boss';
    run.currentBoss = randomFrom(BOSSES);
    run.bossState = { wins:0, losses:0, rolls:[] };
    return;
  }

  const roomTypes = run.path[floorIdx] || ['normal'];
  run.roomType = roomTypes[roomIdx] || 'normal';

  if (run.roomType === 'event') {
    run.currentEvent = randomFrom(EVENTS);
  }
}

function endRun(user, victory=false) {
  const run = user.run;
  user.totalRuns++;
  if (run.score > user.bestRunScore) user.bestRunScore = run.score;
  if (run.floor > user.bestRunFloor)  user.bestRunFloor = run.floor;
  const xpGain = run.score + (victory?50:0) + run.floor*10;
  user.xp += xpGain;
  user.level = Math.floor(1+Math.sqrt(user.xp/50));
  // Convert run score to meta gold
  const goldGain = Math.floor(run.score/5) + run.gold + (victory?30:0);
  user.gold += goldGain;
  user.totalGoldEarned += goldGain;
  const result = { victory, score:run.score, floor:run.floor, goldGain, xpGain };
  user.run = null;
  return result;
}

function calcWinChance(user) {
  const run = user.run;
  let chance = 0.50; // base 50% win
  chance += (run.metaLuckBonus||0)/100;
  if (run.relics.includes('lucky_coin')) chance += 0.15;
  if (run.upgrades.includes('cursed_blessing')) chance += 0.20;
  if (run.relics.includes('void_shard')) {} // handled in roll
  return Math.min(0.92, Math.max(0.05, chance));
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/register',(req,res)=>{
  const{username,password}=req.body;
  if(!username||!password) return res.json({ok:false,error:'Fill both fields'});
  const u=username.trim().toLowerCase();
  if(u.length<2||u.length>20) return res.json({ok:false,error:'Username 2–20 chars'});
  if(!/^[a-z0-9_]+$/.test(u)) return res.json({ok:false,error:'Letters/numbers/underscore only'});
  if(users[u]) return res.json({ok:false,error:'Username taken'});
  users[u]=makeUser(u,password);
  const token=newId(); sessions[token]=u;
  res.json({ok:true,token,user:publicUser(users[u])});
});

app.post('/api/login',(req,res)=>{
  const{username,password}=req.body;
  const u=username?.trim().toLowerCase();
  const user=users[u];
  if(!user||user.passwordHash!==simpleHash(password)) return res.json({ok:false,error:'Wrong username or password'});
  const token=newId(); sessions[token]=u;
  res.json({ok:true,token,user:publicUser(user)});
});

app.get('/api/leaderboard',(_,res)=>res.json(getLeaderboard()));
app.get('/api/meta_upgrades',(_,res)=>res.json(META_UPGRADES));

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection',(ws)=>{
  let username=null;

  ws.on('message',(raw)=>{
    let msg; try{msg=JSON.parse(raw);}catch{return;}
    const{type,data={}}=msg;

    if(type==='auth'){
      const u=sessions[data.token];
      if(!u){send(ws,'auth_fail',{});return;}
      username=u; clients[username]=ws;
      const user=users[username];
      // AFK gold if has regen meta
      if(user.lastSeen){
        const mins=Math.min((Date.now()-user.lastSeen)/60000,1440);
        const regenLvl=user.metaUpgrades?.hp_regen||0;
        if(regenLvl&&user.run){
          const hpGain=Math.floor(mins*regenLvl*0.1);
          user.run.hp=Math.min(user.run.maxHp,(user.run.hp||0)+hpGain);
        }
      }
      send(ws,'authed',{user:publicUser(user),leaderboard:getLeaderboard(),metaUpgrades:META_UPGRADES,online:onlineCount()});
      broadcast('player_online',{username,online:onlineCount()},username);
      return;
    }

    if(!username||!users[username]) return;
    const user=users[username];

    // ── Run: Start ──
    if(type==='start_run'){
      if(user.run?.active){send(ws,'run_error',{error:'Run already in progress'});return;}
      startRun(user);
      send(ws,'run_started',{user:publicUser(user)});
    }

    // ── Run: Abandon ──
    if(type==='abandon_run'){
      if(!user.run){return;}
      const result=endRun(user,false);
      send(ws,'run_ended',{result,user:publicUser(user)});
      broadcast('leaderboard',getLeaderboard());
    }

    // ── Run: Roll ──
    if(type==='run_roll'){
      const run=user.run;
      if(!run||!run.active||run.roomCleared){send(ws,'roll_denied',{});return;}

      // Preview relic — show what will happen
      if(run.relics.includes('crystal_ball')&&run.previewNext===null){
        const previewVal=rollDice(run);
        run.previewNext=previewVal;
        send(ws,'roll_preview',{val:previewVal,user:publicUser(user)});
        return;
      }

      let val;
      if(run.previewNext!==null){val=run.previewNext; run.previewNext=null;}
      else val=rollDice(run);

      const result=resolveRoll(user,val);
      send(ws,'roll_result',{...result,user:publicUser(user)});
      if(user.run===null){
        // run ended mid-roll (death)
        broadcast('leaderboard',getLeaderboard());
      } else if(run.roomCleared){
        broadcast('leaderboard',getLeaderboard());
      }
    }

    // ── Run: Reroll ──
    if(type==='run_reroll'){
      const run=user.run;
      if(!run||run.rerollUsed||!run.upgrades.includes('reroll')){send(ws,'roll_denied',{});return;}
      run.rerollUsed=true;
      send(ws,'rerolled',{user:publicUser(user)});
    }

    // ── Run: Skip (meditate) ──
    if(type==='run_skip'){
      const run=user.run;
      if(!run||run.skipUsed||!run.upgrades.includes('meditate')){send(ws,'roll_denied',{});return;}
      run.skipUsed=true;
      run.gold+=8;
      run.score+=8;
      send(ws,'skipped',{user:publicUser(user)});
    }

    // ── Run: Choose upgrade ──
    if(type==='choose_upgrade'){
      const run=user.run;
      if(!run||!run.upgradeChoices) return;
      const chosen=run.upgradeChoices.find(u=>u.id===data.id);
      if(!chosen) return;
      run.upgrades.push(chosen.id);
      if(chosen.id==='cursed_blessing') run.maxHp=Math.max(10,run.maxHp-10);
      run.upgradeChoices=null;
      advanceToNextRoom(user);
      send(ws,'upgrade_chosen',{upgrade:chosen,user:publicUser(user)});
    }

    // ── Run: Choose relic ──
    if(type==='choose_relic'){
      const run=user.run;
      if(!run||!run.relicChoices) return;
      const chosen=run.relicChoices.find(r=>r.id===data.id);
      if(!chosen) return;
      run.relics.push(chosen.id);
      run.relicChoices=null;
      advanceToNextRoom(user);
      send(ws,'relic_chosen',{relic:chosen,user:publicUser(user)});
    }

    // ── Run: Event choice ──
    if(type==='event_choice'){
      const run=user.run;
      if(!run||!run.currentEvent) return;
      const ev=run.currentEvent;
      let msg='';
      if(ev.effect.hp){
        run.hp=Math.min(run.maxHp,run.hp+ev.effect.hp);
        msg+=ev.effect.hp>0?`+${ev.effect.hp} HP`:`${ev.effect.hp} HP`;
      }
      if(ev.effect.gold){run.gold+=ev.effect.gold; msg+=` ${ev.effect.gold>0?'+':''}${ev.effect.gold} gold`;}
      if(ev.effect.relic){run.relicChoices=pickRelics(run,2); send(ws,'event_result',{msg,user:publicUser(user)}); return;}
      if(ev.effect.gamble){
        const gv=Math.floor(Math.random()*6)+1;
        if(gv<=3){run.gold=Math.max(0,run.gold-20);msg=`Rolled ${gv} — lost 20 gold!`;}
        else{run.gold+=40;msg=`Rolled ${gv} — gained 40 gold!`;}
      }
      if(ev.effect.deal){
        const up=weightedRandom(RUN_UPGRADES.filter(u=>!run.upgrades.includes(u.id)));
        const price=Math.floor(25*(1-(user.metaUpgrades.shop_discount||0)*0.1));
        if(run.gold>=price&&up){run.gold-=price;run.upgrades.push(up.id);msg=`Bought ${up.name}!`;}
        else{msg='Not enough gold!';}
      }
      run.currentEvent=null;
      run.roomCleared=true;
      send(ws,'event_result',{msg,user:publicUser(user)});
    }

    // ── Run: Next room ──
    if(type==='next_room'){
      const run=user.run;
      if(!run||!run.roomCleared||run.upgradeChoices||run.relicChoices) return;
      advanceToNextRoom(user);
      send(ws,'room_changed',{user:publicUser(user)});
    }

    // ── Meta: Buy upgrade ──
    if(type==='buy_meta'){
      const item=META_UPGRADES.find(u=>u.id===data.id);
      if(!item) return;
      const lvl=user.metaUpgrades[item.id]||0;
      if(lvl>=item.maxLevel){send(ws,'buy_fail',{error:'Max level'});return;}
      const cost=Math.floor(item.cost*Math.pow(1.8,lvl));
      if(user.gold<cost){send(ws,'buy_fail',{error:'Not enough gold'});return;}
      user.gold-=cost; user.metaUpgrades[item.id]=(lvl+1);
      send(ws,'meta_bought',{id:item.id,user:publicUser(user)});
    }

    // ── Friends ──
    if(type==='friend_request'){
      const target=users[data.username?.toLowerCase()];
      if(!target){send(ws,'friend_error',{error:'Player not found'});return;}
      if(target.username===username){send(ws,'friend_error',{error:"That's you!"});return;}
      if(user.friends.includes(target.username)){send(ws,'friend_error',{error:'Already friends'});return;}
      if(user.sentRequests.includes(target.username)){send(ws,'friend_error',{error:'Already sent'});return;}
      if(target.sentRequests.includes(username)){acceptFriend(username,target.username);return;}
      user.sentRequests.push(target.username);
      target.friendRequests.push(username);
      send(ws,'friend_request_sent',{to:target.username,user:publicUser(user)});
      sendTo(target.username,'friend_request_received',{from:username,fromDisplay:user.displayName,user:publicUser(target)});
    }
    if(type==='accept_friend') acceptFriend(username,data.username?.toLowerCase());
    if(type==='decline_friend'){
      const from=data.username?.toLowerCase();
      user.friendRequests=user.friendRequests.filter(r=>r!==from);
      if(users[from]) users[from].sentRequests=users[from].sentRequests.filter(r=>r!==username);
      send(ws,'friend_declined',{user:publicUser(user)});
    }
    if(type==='remove_friend'){
      const f=data.username?.toLowerCase();
      user.friends=user.friends.filter(x=>x!==f);
      if(users[f]) users[f].friends=users[f].friends.filter(x=>x!==username);
      send(ws,'friends_update',{user:publicUser(user)});
      sendTo(f,'friends_update',{user:publicUser(users[f])});
    }

    // ── Profile ──
    if(type==='update_profile'){
      const{displayName,bio,avatarColor,avatarEmoji}=data;
      if(displayName&&displayName.trim().length<=24) user.displayName=displayName.trim();
      if(bio!==undefined&&bio.length<=120) user.bio=bio;
      if(avatarColor) user.avatarColor=avatarColor;
      if(avatarEmoji) user.avatarEmoji=avatarEmoji;
      send(ws,'profile_updated',{user:publicUser(user)});
      broadcast('leaderboard',getLeaderboard());
    }
  });

  ws.on('close',()=>{
    if(username&&users[username]){
      users[username].lastSeen=Date.now();
      delete clients[username];
      broadcast('player_offline',{username,online:onlineCount()});
    }
  });
});

function rollDice(run) {
  if(run.relics.includes('void_shard')) {
    // jackpot on 5 or 6
    const r=Math.random();
    if(r<0.333) return Math.floor(Math.random()*3)+1;
    return Math.random()<0.5?5:6;
  }
  // guarantee every 5th roll
  if(run.relics.includes('hourglass')){
    run.rollsUntilGuarantee=(run.rollsUntilGuarantee||5)-1;
    if(run.rollsUntilGuarantee<=0){run.rollsUntilGuarantee=5;return 6;}
  }
  return Math.floor(Math.random()*6)+1;
}

function resolveRoll(user,val) {
  const run=user.run;
  run.rollsThisRoom++;
  user.totalWins= user.totalWins||0;

  const winChance=calcWinChance(user);
  const isWin=val>=4||(Math.random()<winChance&&val>=3);
  const isJackpot=val===6||(run.relics.includes('void_shard')&&val===5);

  let goldGain=0, hpChange=0, msgs=[];

  if(isJackpot){
    goldGain=20; run.winsThisRoom++; run.streak++; user.totalWins++;
    if(run.relics.includes('golden_chalice')) goldGain+=20;
    if(run.relics.includes('gamblers_token')) goldGain+=run.streak*5;
    if(run.upgrades.includes('glass_cannon')) goldGain+=50;
    if(run.upgrades.includes('gold_magnet')) goldGain+=5;
    if(run.upgrades.includes('berserker')) goldGain+=run.streak*2;
    if(run.upgrades.includes('double_or_nothing')) goldGain*=2;
    if(run.upgrades.includes('bloodlust')||run.relics.includes('vampiric_orb')) hpChange+=run.upgrades.includes('bloodlust')?2:0;
    if(run.relics.includes('vampiric_orb')) hpChange+=3;
    msgs.push('⭐ JACKPOT!');
  } else if(isWin||val>=4){
    goldGain=10; run.winsThisRoom++; run.streak++; user.totalWins++;
    if(run.relics.includes('gamblers_token')) goldGain+=run.streak*5;
    if(run.upgrades.includes('gold_magnet')) goldGain+=5;
    if(run.upgrades.includes('berserker')) goldGain+=run.streak*2;
    if(run.upgrades.includes('double_or_nothing')) goldGain*=2;
    if(run.upgrades.includes('bloodlust')) hpChange+=2;
    if(run.relics.includes('vampiric_orb')) hpChange+=3;
    msgs.push('✅ Win!');
  } else {
    // miss
    run.lossesThisRoom++; run.streak=0;
    let dmg=run.roomType==='elite'?15:run.roomType==='boss'?20:10;
    if(run.upgrades.includes('glass_cannon')) dmg+=5;
    if(run.relics.includes('cursed_mirror')){ goldGain+=5; msgs.push('+5 gold (Cursed Mirror)'); }
    if(run.relics.includes('iron_dice')||run.upgrades.includes('shield_roll')&&!run.shieldUsed){
      if(run.upgrades.includes('shield_roll')&&!run.shieldUsed) run.shieldUsed=true;
      dmg=0; msgs.push('🛡 Blocked!');
    }
    if(run.upgrades.includes('double_or_nothing')){ hpChange-=10; msgs.push('-10 HP (D&N penalty)'); dmg=0; }
    hpChange-=dmg;
    msgs.push(`❌ Miss! ${dmg?`-${dmg} HP`:'(blocked)'}`);
  }

  // apply bonus luck streak extra roll
  let extraRoll=false;
  if(run.upgrades.includes('lucky_streak')&&run.streak>=3&&run.rollsThisRoom<6) extraRoll=true;

  run.gold+=goldGain; run.score+=goldGain;
  run.hp=Math.min(run.maxHp,run.hp+hpChange);

  // Death
  if(run.hp<=0){
    if(run.relics.includes('phoenix_feather')&&!run.reviveUsed){
      run.hp=1; run.reviveUsed=true; msgs.push('🔥 Phoenix revive!');
    } else {
      const result=endRun(user,false);
      return{val,isJackpot,goldGain,hpChange,msgs,runEnded:true,runResult:result,extraRoll:false};
    }
  }

  // Room clear check
  const cleared=checkRoomClear(user);
  if(cleared){
    run.roomCleared=true;
    const floorReward=(user.metaUpgrades.floor_reward||0)*10;
    if(run.room+1>=ROOMS_PER_FLOOR){
      // Floor complete — offer upgrade or relic
      run.gold+=floorReward;
      if(run.floor===BOSS_FLOOR){
        const result=endRun(user,true);
        return{val,isJackpot,goldGain,hpChange,msgs,roomCleared:true,floorComplete:true,victory:true,runEnded:true,runResult:result,extraRoll:false};
      }
      const offerRelic=Math.random()<0.35||run.floor%3===0;
      if(offerRelic) run.relicChoices=pickRelics(run,3);
      else run.upgradeChoices=pickUpgrades(run,3);
      // HP regen between floors
      const regenLvl=user.metaUpgrades.hp_regen||0;
      if(regenLvl) run.hp=Math.min(run.maxHp,run.hp+regenLvl*2);
      msgs.push(`🏆 Floor ${run.floor} complete! +${floorReward} gold`);
    }
  }

  return{val,isJackpot,isWin:isJackpot||(val>=4),goldGain,hpChange,msgs,roomCleared:cleared,extraRoll};
}

function checkRoomClear(user) {
  const run=user.run;
  if(run.roomType==='boss'){
    const bs=run.bossState;
    if(run.currentBoss.id==='the_void') return run.winsThisRoom>=5;
    if(run.currentBoss.id==='iron_judge') return run.winsThisRoom>=3;
    if(run.currentBoss.id==='fortune_god') return run.rollsThisRoom>=5;
    return run.winsThisRoom>=4;
  }
  if(run.roomType==='elite') return run.winsThisRoom>=4;
  if(run.roomType==='treasure') return true; // handled by event
  if(run.roomType==='curse_shrine') return run.rollsThisRoom>=1;
  if(run.roomType==='blessing') return run.rollsThisRoom>=1;
  if(run.roomType==='shop_room') return true;
  return run.winsThisRoom>=3; // normal: 3 wins
}

function advanceToNextRoom(user) {
  const run=user.run;
  run.room++;
  if(run.room>=ROOMS_PER_FLOOR){
    run.room=0; run.floor++;
  }
  if(run.floor>FLOORS_PER_RUN){endRun(user,true);return;}
  advanceRoom(user);
}

function pickUpgrades(run,n) {
  const pool=RUN_UPGRADES.filter(u=>!run.upgrades.includes(u.id));
  const picks=[]; const used=new Set();
  while(picks.length<n&&picks.length<pool.length){
    const pick=weightedRandom(pool.filter(u=>!used.has(u.id)));
    if(pick){used.add(pick.id);picks.push(pick);}
    else break;
  }
  return picks;
}

function pickRelics(run,n) {
  const pool=RELICS.filter(r=>!run.relics.includes(r.id));
  const picks=[]; const used=new Set();
  while(picks.length<n&&picks.length<pool.length){
    const idx=Math.floor(Math.random()*pool.length);
    const r=pool[idx];
    if(!used.has(r.id)){used.add(r.id);picks.push(r);}
  }
  return picks;
}

function acceptFriend(a,b){
  const ua=users[a],ub=users[b]; if(!ua||!ub) return;
  if(!ua.friends.includes(b)) ua.friends.push(b);
  if(!ub.friends.includes(a)) ub.friends.push(a);
  ua.friendRequests=ua.friendRequests.filter(r=>r!==b);
  ua.sentRequests=ua.sentRequests.filter(r=>r!==b);
  ub.friendRequests=ub.friendRequests.filter(r=>r!==a);
  ub.sentRequests=ub.sentRequests.filter(r=>r!==a);
  sendTo(a,'friend_accepted',{with:b,user:publicUser(ua)});
  sendTo(b,'friend_accepted',{with:a,user:publicUser(ub)});
}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Fortune Roll Roguelike on http://localhost:${PORT}`));
