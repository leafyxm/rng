const el = id => document.getElementById(id);

let ws = null;
let playerId = null;
let roomCode = null;
let currentState = null;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function connect() {
  ws = new WebSocket(wsUrl());

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'joined') {
      playerId = msg.playerId;
      roomCode = msg.code;
    } else if (msg.type === 'state') {
      currentState = msg.state;
      render(currentState);
    } else if (msg.type === 'error') {
      el('lobbyMsg').textContent = msg.message;
    }
  });

  ws.addEventListener('close', () => {
    el('lobbyMsg').textContent = 'Connection lost. Refresh to reconnect.';
  });

  ws.addEventListener('error', () => {
    el('lobbyMsg').textContent = 'Could not connect to server.';
  });
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function renderCardEl(card, faceDown) {
  const div = document.createElement('div');
  if (faceDown) { div.className = 'card back'; return div; }
  div.className = 'card' + (card.color === 'red' ? ' red' : '');
  div.innerHTML = `<div>${card.rank}</div><div class="suit-mid">${card.suit}</div><div class="rank-bottom">${card.rank}</div>`;
  return div;
}

function handTotal(hand) {
  let total = hand.reduce((s, c) => s + cardValue(c), 0);
  let aces = hand.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function cardValue(c) {
  if (c.rank === 'A') return 11;
  if (['K', 'Q', 'J'].includes(c.rank)) return 10;
  return parseInt(c.rank, 10);
}

function render(state) {
  el('lobby').style.display = 'none';

  if (state.order.length < 2) {
    el('waitingPanel').style.display = 'block';
    el('gameTable').style.display = 'none';
    el('codeDisplay').textContent = roomCode;
    return;
  }

  el('waitingPanel').style.display = 'none';
  el('gameTable').style.display = 'block';
  el('roomCodeShow').textContent = roomCode;
  el('roundShow').textContent = state.round || 1;

  const dCardsEl = el('dealerCards');
  dCardsEl.innerHTML = '';
  state.dealerHand.forEach((c, i) => dCardsEl.appendChild(renderCardEl(c, state.dealerHidden && i === 1)));
  el('dealerTotal').textContent = state.dealerHidden ? '?' : handTotal(state.dealerHand);

  const ids = state.order;
  [{ id: 1, pid: ids[0] }, { id: 2, pid: ids[1] }].forEach(({ id, pid }) => {
    const p = state.players[pid];
    const isYou = pid === playerId;
    el(`player${id}Name`).innerHTML = `${p.name} ${isYou ? '<span class="badge you">you</span>' : '<span class="badge">opponent</span>'}`;
    const cardsEl = el(`player${id}Cards`);
    cardsEl.innerHTML = '';
    p.hand.forEach(c => cardsEl.appendChild(renderCardEl(c, false)));

    let totalText = String(handTotal(p.hand));
    if (p.status === 'bust') totalText += ' (bust)';
    if (p.status === 'blackjack') totalText += ' (blackjack!)';
    const totalEl = el(`player${id}Total`);
    totalEl.textContent = totalText;
    if (state.phase === 'results' && p.result) {
      const tag = document.createElement('span');
      tag.className = `result-tag ${p.result}`;
      tag.textContent = p.result.toUpperCase();
      totalEl.appendChild(tag);
    }
    el(`player${id}Area`).classList.toggle('active-turn', state.phase === 'playing' && state.turn === pid);
  });

  const me = state.players[playerId];
  const myTurn = state.phase === 'playing' && state.turn === playerId && me.status === 'playing';
  el('hitBtn').disabled = !myTurn;
  el('standBtn').disabled = !myTurn;

  if (state.phase === 'playing') {
    el('status').textContent = myTurn
      ? 'Your turn — Hit or Stand?'
      : `Waiting for ${state.players[state.turn] ? state.players[state.turn].name : '...'}...`;
    el('actionRow').style.display = 'flex';
    el('againRow').style.display = 'none';
  } else if (state.phase === 'results') {
    el('status').textContent = state.log || 'Round complete.';
    el('actionRow').style.display = 'none';
    el('againRow').style.display = 'flex';
  }
}

el('createBtn').addEventListener('click', () => {
  const name = el('nameInput').value.trim() || 'Player 1';
  send({ type: 'create', name });
});

el('joinBtn').addEventListener('click', () => {
  const code = el('codeInput').value.trim().toUpperCase();
  const name = el('nameInput').value.trim() || 'Player 2';
  if (!code) { el('lobbyMsg').textContent = 'Enter a room code.'; return; }
  send({ type: 'join', code, name });
});

el('copyBtn').addEventListener('click', () => {
  if (navigator.clipboard) navigator.clipboard.writeText(roomCode).catch(() => {});
  el('copyBtn').textContent = 'Copied!';
  setTimeout(() => { el('copyBtn').textContent = 'Copy Code'; }, 1200);
});

el('hitBtn').addEventListener('click', () => send({ type: 'hit' }));
el('standBtn').addEventListener('click', () => send({ type: 'stand' }));
el('againBtn').addEventListener('click', () => send({ type: 'again' }));

el('leaveBtn').addEventListener('click', () => {
  location.reload();
});

connect();
