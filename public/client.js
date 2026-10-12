const $ = (id) => document.getElementById(id);

if (typeof io === 'undefined') {
  $('joinErr').textContent =
    'Cannot reach the game server. Run "npm start" in the project folder, then open http://localhost:3000 in your browser. Do not open index.html by double-click.';
  throw new Error('Socket.IO did not load. Is the server running?');
}
const socket = io();
socket.on('connect_error', () => {
  $('joinErr').textContent = 'Connection problem. Is the server running? (npm start)';
});

let room = null;
let role = { role: 'guesser' };
let offset = 0;          // server time - client time
let myVote = null;
let lastReveal = null;
let prevPhase = null;
let hintsLeft = 2;
let color = '#111111';
let size = 6;

const BG = '#fbfbf6';
const COLORS = ['#111111', '#e63946', '#f4a261', '#ffd23f', '#2a9d8f', '#1d7ef5', '#7b2cbf', BG];
const canvas = $('board');
const ctx = canvas.getContext('2d');

// ---------- Join ----------
function go(kind) {
  $('joinErr').textContent = '';
  socket.emit(kind, { name: $('name').value, code: $('code').value }, (res) => {
    if (!res || !res.ok) { $('joinErr').textContent = (res && res.error) || 'Could not connect.'; return; }
    $('join').hidden = true;
    $('game').hidden = false;
  });
}
$('createBtn').onclick = () => go('create');
$('joinBtn').onclick = () => go('join');
$('code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

// ---------- Canvas ----------
function clearBoard() {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
clearBoard();

function drawSeg(s) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.c;
  ctx.lineWidth = s.s;
  ctx.beginPath();
  ctx.moveTo(s.x0 * canvas.width, s.y0 * canvas.height);
  ctx.lineTo(s.x1 * canvas.width, s.y1 * canvas.height);
  ctx.stroke();
}

const canDraw = () => room && room.phase === 'draw' && socket.id === room.drawerId;

function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}
function sendSeg(a, b) {
  const seg = { x0: a.x, y0: a.y, x1: b.x, y1: b.y, c: color, s: size };
  drawSeg(seg);
  socket.emit('draw', seg);
}

let drawing = false;
let last = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!canDraw()) return;
  drawing = true;
  last = pos(e);
  canvas.setPointerCapture(e.pointerId);
  sendSeg(last, last);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const p = pos(e);
  sendSeg(last, p);
  last = p;
});
['pointerup', 'pointercancel'].forEach((ev) => canvas.addEventListener(ev, () => { drawing = false; }));

// Tools
COLORS.forEach((c) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch' + (c === color ? ' on' : '');
  b.style.background = c;
  b.title = c === BG ? 'Eraser' : 'Color';
  b.setAttribute('aria-label', b.title + ' ' + c);
  b.onclick = () => {
    color = c;
    document.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
  };
  $('swatches').appendChild(b);
});
$('size').oninput = (e) => { size = Number(e.target.value); };
$('clearBtn').onclick = () => socket.emit('clearBoard');

// ---------- Chat ----------
function addMsg(html, cls) {
  const p = document.createElement('p');
  p.className = 'msg ' + (cls || '');
  if (html.name !== undefined) {
    const b = document.createElement('b');
    b.textContent = html.name + ': ';
    p.appendChild(b);
    p.appendChild(document.createTextNode(html.text));
  } else {
    p.textContent = html;
  }
  $('chat').appendChild(p);
  $('chat').scrollTop = $('chat').scrollHeight;
}

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('chatInput').value.trim();
  if (t) socket.emit('chat', t);
  $('chatInput').value = '';
});

$('hintForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('hintInput').value.trim();
  if (!t || hintsLeft <= 0) return;
  socket.emit('hint', t);
  hintsLeft--;
  $('hintInput').value = '';
  $('hintNote').textContent = hintsLeft + ' hint(s) left';
});

// ---------- Socket events ----------
socket.on('room', (r) => {
  offset = r.now - Date.now();
  if (r.phase !== prevPhase) {
    if (r.phase === 'draw') { myVote = null; lastReveal = null; hintsLeft = 2; $('hintNote').textContent = '2 hint(s) left'; }
    prevPhase = r.phase;
  }
  room = r;
  render();
});
socket.on('role', (r) => { role = r; render(); });
socket.on('draw', drawSeg);
socket.on('clear', clearBoard);
socket.on('chat', (m) => addMsg(m, m.secret ? 'secret' : ''));
socket.on('system', (t) => addMsg(t, 'sys'));
socket.on('hint', (t) => addMsg('💡 Anonymous hint: ' + t, 'hint'));
socket.on('reveal', (d) => { lastReveal = d; render(); });

// ---------- Render ----------
function nameOf(id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '?';
}

function render() {
  if (!room) return;
  const ph = room.phase;
  const me = socket.id;

  $('roomInfo').textContent = ph === 'lobby'
    ? `Room ${room.code}`
    : `Room ${room.code} · Round ${room.round}/${room.totalRounds}`;

  // Players list
  const list = $('players');
  list.innerHTML = '';
  [...room.players].sort((a, b) => b.score - a.score).forEach((p) => {
    const li = document.createElement('li');
    if (!p.connected) li.className = 'off';
    if (p.id === me) li.classList.add('me');
    const left = document.createElement('span');
    left.className = 'pname';
    let badge = '';
    if (p.id === room.host) badge += '👑 ';
    if (ph === 'draw' && p.id === room.drawerId) badge += '✏️ ';
    if (ph === 'draw' && p.guessed) badge += '✅ ';
    if (ph === 'vote' && p.voted) badge += '🗳 ';
    left.textContent = badge + p.name;
    const right = document.createElement('span');
    right.className = 'score';
    right.textContent = p.score;
    li.append(left, right);
    list.appendChild(li);
  });

  renderBanner(ph, me);
  renderWord(ph);

  // Overlays
  $('lobby').hidden = ph !== 'lobby';
  $('vote').hidden = ph !== 'vote';
  $('reveal').hidden = !(ph === 'reveal' && lastReveal);
  $('end').hidden = ph !== 'end';

  if (ph === 'lobby') {
    $('lobbyCode').textContent = room.code;
    $('minP').max = $('maxP').max = room.hardMax;
    if (document.activeElement !== $('minP')) $('minP').value = room.minPlayers;
    if (document.activeElement !== $('maxP')) $('maxP').value = room.maxPlayers;
    const n = room.players.length;
    $('lobbyCount').textContent = `${n} player(s). Need ${room.minPlayers} to ${room.maxPlayers}.`;
    const isHost = me === room.host;
    $('hostControls').hidden = !isHost;
    $('startBtn').disabled = n < room.minPlayers;
    $('lobbyWait').textContent = isHost
      ? (n < room.minPlayers ? `Waiting for ${room.minPlayers - n} more player(s).` : 'Ready to start!')
      : 'Waiting for the host to start.';
  }
  if (ph === 'vote') renderVote(me);
  if (ph === 'reveal' && lastReveal) renderReveal();
  if (ph === 'end') renderEnd(me);

  // Tools
  $('tools').hidden = !canDraw();
  $('hintForm').hidden = !(ph === 'draw' && (role.role === 'drawer' || role.role === 'saboteur'));
  $('chatInput').placeholder = ph === 'draw' && role.role === 'guesser'
    ? 'Type your guess here' : 'Type a message';
}

function renderBanner(ph, me) {
  const b = $('roleBanner');
  b.className = 'banner';
  if (ph === 'lobby') b.textContent = 'Waiting for players...';
  else if (ph === 'vote') b.textContent = 'Voting time. Who tried to confuse us?';
  else if (ph === 'reveal') b.textContent = 'Round result';
  else if (ph === 'end') b.textContent = 'Final scores';
  else if (role.role === 'drawer') {
    b.classList.add('drawer');
    b.textContent = 'You are the DRAWER. Draw the word. You can send 2 anonymous hints.';
  } else if (role.role === 'saboteur') {
    b.classList.add('saboteur');
    b.textContent = 'You are the SABOTEUR. Guide people to the decoy word. Do not get caught!';
  } else {
    b.textContent = `${nameOf(room.drawerId)} is drawing. Guess the word!` + (room.players.length >= 3 ? ' One player is a saboteur.' : '');
  }
}

function renderWord(ph) {
  const w = $('wordBox');
  w.innerHTML = '';
  if (ph !== 'draw') return;
  if (role.role === 'drawer') {
    w.textContent = role.word.toUpperCase();
  } else if (role.role === 'saboteur') {
    w.textContent = role.word.toUpperCase();
    const s = document.createElement('small');
    s.textContent = `Decoy: ${role.decoy}`;
    w.appendChild(s);
  } else {
    w.textContent = room.wordLength ? Array(room.wordLength).fill('_').join(' ') : '';
  }
}

function renderVote(me) {
  $('voteNote').textContent = role.role === 'saboteur'
    ? 'You are the saboteur. Your vote does not count, but act natural!'
    : 'Pick one player. Right guess = +150 points.';
  const box = $('voteList');
  box.innerHTML = '';
  room.players.filter((p) => p.id !== me && p.connected).forEach((p) => {
    const b = document.createElement('button');
    b.textContent = p.name;
    if (myVote === p.id) b.className = 'picked';
    b.onclick = () => { myVote = p.id; socket.emit('vote', p.id); render(); };
    box.appendChild(b);
  });
}

function renderReveal() {
  const d = lastReveal;
  if (!d.saboteurId) {
    $('revealTitle').textContent = 'Round over';
    $('revealBody').textContent = `The word was "${d.word}". ${d.guessedCount} player(s) guessed it. (No saboteur with 2 players.)`;
    return;
  }
  $('revealTitle').textContent = d.caught ? 'Saboteur caught!' : 'Saboteur escaped!';
  const votes = d.tally[d.saboteurId] || 0;
  $('revealBody').textContent =
    `The word was "${d.word}". The decoy was "${d.decoy}". ` +
    `${d.saboteurName} was the saboteur (${votes} vote(s)). ` +
    `${d.guessedCount} player(s) guessed the word.`;
}

function renderEnd(me) {
  const ol = $('finalBoard');
  ol.innerHTML = '';
  [...room.players].sort((a, b) => b.score - a.score).forEach((p) => {
    const li = document.createElement('li');
    li.textContent = `${p.name}: ${p.score}`;
    ol.appendChild(li);
  });
  const host = me === room.host;
  $('againBtn').hidden = !host;
  $('againWait').hidden = host;
}

['minP', 'maxP'].forEach((id) => $(id).addEventListener('change', () => {
  socket.emit('settings', { min: $('minP').value, max: $('maxP').value });
}));
$('startBtn').onclick = () => socket.emit('start', { rounds: $('rounds').value });
$('againBtn').onclick = () => socket.emit('playAgain');

// ---------- Timer ----------
setInterval(() => {
  const t = $('timer');
  if (!room || !room.endsAt || room.phase === 'lobby' || room.phase === 'end') { t.textContent = '--'; t.classList.remove('low'); return; }
  const s = Math.max(0, Math.ceil((room.endsAt - (Date.now() + offset)) / 1000));
  t.textContent = s;
  t.classList.toggle('low', s <= 10);
}, 250);
