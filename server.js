const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Card helpers ----------
const SUITS = [
  { sym: '♠', color: 'black' }, { sym: '♥', color: 'red' },
  { sym: '♦', color: 'red' }, { sym: '♣', color: 'black' }
];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function buildShuffledDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit: suit.sym, color: suit.color });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function draw(deck) { return deck.pop() || null; }
function cardValue(c) {
  if (c.rank === 'A') return 11;
  if (['K', 'Q', 'J'].includes(c.rank)) return 10;
  return parseInt(c.rank, 10);
}
function handTotal(hand) {
  let total = hand.reduce((s, c) => s + cardValue(c), 0);
  let aces = hand.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function genCode(rooms) {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

// ---------- Room state ----------
// rooms: code -> { code, deck, dealerHand, dealerHidden, phase, turn, order, players, round, log }
// players: id -> { name, hand, status, result, ws }
const rooms = new Map();

function publicState(room) {
  // strip ws sockets before sending to clients
  const players = {};
  for (const [pid, p] of Object.entries(room.players)) {
    players[pid] = { name: p.name, hand: p.hand, status: p.status, result: p.result };
  }
  return {
    code: room.code,
    phase: room.phase,
    dealerHand: room.dealerHand,
    dealerHidden: room.dealerHidden,
    turn: room.turn,
    order: room.order,
    players,
    round: room.round,
    log: room.log
  };
}

function broadcast(room) {
  const payload = JSON.stringify({ type: 'state', state: publicState(room) });
  for (const pid of room.order) {
    const ws = room.players[pid] && room.players[pid].ws;
    if (ws && ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function dealNewRound(room) {
  room.deck = buildShuffledDeck();
  room.dealerHand = [draw(room.deck), draw(room.deck)];
  room.dealerHidden = true;
  room.phase = 'playing';
  room.order.forEach(pid => {
    const hand = [draw(room.deck), draw(room.deck)];
    room.players[pid].hand = hand;
    room.players[pid].status = handTotal(hand) === 21 ? 'blackjack' : 'playing';
    room.players[pid].result = null;
  });
  room.turn = room.order.find(pid => room.players[pid].status === 'playing') || null;
  room.log = 'New round dealt.';
  if (!room.turn) finishToDealer(room);
}

function finishToDealer(room) {
  room.dealerHidden = false;
  while (handTotal(room.dealerHand) < 17) {
    const c = draw(room.deck);
    if (!c) break;
    room.dealerHand.push(c);
  }
  const dTotal = handTotal(room.dealerHand);
  room.order.forEach(pid => {
    const p = room.players[pid];
    const pTotal = handTotal(p.hand);
    if (p.status === 'bust') p.result = 'lose';
    else if (dTotal > 21) p.result = 'win';
    else if (pTotal > dTotal) p.result = 'win';
    else if (pTotal < dTotal) p.result = 'lose';
    else p.result = 'push';
  });
  room.phase = 'results';
  room.turn = null;
  room.log = 'Round complete.';
}

function advanceTurn(room) {
  const idx = room.order.indexOf(room.turn);
  for (let i = idx + 1; i < room.order.length; i++) {
    if (room.players[room.order[i]].status === 'playing') {
      room.turn = room.order[i];
      return;
    }
  }
  finishToDealer(room);
}

function removePlayer(ws) {
  for (const room of rooms.values()) {
    for (const [pid, p] of Object.entries(room.players)) {
      if (p.ws === ws) {
        room.log = `${p.name} disconnected.`;
        p.ws = null;
        broadcast(room);
        // clean up empty rooms after a delay
        setTimeout(() => {
          const stillConnected = room.order.some(id => room.players[id] && room.players[id].ws);
          if (!stillConnected) rooms.delete(room.code);
        }, 30000);
        return;
      }
    }
  }
}

// ---------- WebSocket handling ----------
wss.on('connection', (ws) => {
  let myPlayerId = null;
  let myRoomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'create') {
      const name = (msg.name || 'Player 1').slice(0, 16);
      const code = genCode(rooms);
      const pid = Math.random().toString(36).slice(2, 10);
      const room = {
        code, deck: buildShuffledDeck(), dealerHand: [], dealerHidden: true,
        phase: 'waiting', turn: null, order: [pid],
        players: { [pid]: { name, hand: [], status: 'waiting', result: null, ws } },
        round: 1, log: `${name} created the room.`
      };
      rooms.set(code, room);
      myPlayerId = pid; myRoomCode = code;
      ws.send(JSON.stringify({ type: 'joined', playerId: pid, code }));
      broadcast(room);
    }

    else if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase().trim();
      const name = (msg.name || 'Player 2').slice(0, 16);
      const room = rooms.get(code);
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found.' })); return; }
      if (room.order.length >= 2) { ws.send(JSON.stringify({ type: 'error', message: 'Room is full.' })); return; }
      const pid = Math.random().toString(36).slice(2, 10);
      room.order.push(pid);
      room.players[pid] = { name, hand: [], status: 'waiting', result: null, ws };
      dealNewRound(room);
      myPlayerId = pid; myRoomCode = code;
      ws.send(JSON.stringify({ type: 'joined', playerId: pid, code }));
      broadcast(room);
    }

    else if (msg.type === 'hit') {
      const room = rooms.get(myRoomCode);
      if (!room || room.phase !== 'playing' || room.turn !== myPlayerId) return;
      const p = room.players[myPlayerId];
      const c = draw(room.deck);
      if (!c) return;
      p.hand.push(c);
      const total = handTotal(p.hand);
      if (total > 21) p.status = 'bust';
      else if (total === 21) p.status = 'stand';
      if (p.status !== 'playing') advanceTurn(room);
      broadcast(room);
    }

    else if (msg.type === 'stand') {
      const room = rooms.get(myRoomCode);
      if (!room || room.phase !== 'playing' || room.turn !== myPlayerId) return;
      room.players[myPlayerId].status = 'stand';
      advanceTurn(room);
      broadcast(room);
    }

    else if (msg.type === 'again') {
      const room = rooms.get(myRoomCode);
      if (!room || room.phase !== 'results') return;
      room.round += 1;
      dealNewRound(room);
      broadcast(room);
    }
  });

  ws.on('close', () => removePlayer(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Blackjack Online listening on port ${PORT}`));
