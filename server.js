const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const WORDS = require('./words');

// ---------- Settings ----------
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS) || 10; // set MIN_PLAYERS=2 to test alone
const MAX_PLAYERS = 15;
const DRAW_SECONDS = 80;
const VOTE_SECONDS = 25;
const REVEAL_SECONDS = 9;
const PORT = process.env.PORT || 3004;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

// ---------- Helpers ----------
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const cleanName = (n) =>
  String(n || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Player' + Math.floor(Math.random() * 900 + 100);

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(hostId) {
  return {
    code: makeCode(), host: hostId, players: new Map(), phase: 'lobby',
    round: 0, totalRounds: 5, used: new Set(),
    minPlayers: Math.min(MAX_PLAYERS, Math.max(2, MIN_PLAYERS)), maxPlayers: MAX_PLAYERS,
    drawerId: null, saboteurId: null, word: '', decoy: '',
    guessed: new Set(), votes: new Map(), hints: {},
    endsAt: 0, timer: null
  };
}

function publicRoom(r) {
  return {
    now: Date.now(), code: r.code, phase: r.phase, host: r.host,
    round: r.round, totalRounds: r.totalRounds, drawerId: r.drawerId,
    endsAt: r.endsAt, wordLength: r.phase === 'draw' ? r.word.length : 0,
    minPlayers: r.minPlayers, maxPlayers: r.maxPlayers, hardMax: MAX_PLAYERS,
    players: [...r.players.values()].map((p) => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected,
      guessed: r.guessed.has(p.id), voted: r.votes.has(p.id)
    }))
  };
}

const broadcast = (r) => io.to(r.code).emit('room', publicRoom(r));
const system = (r, text) => io.to(r.code).emit('system', text);
const connectedPlayers = (r) => [...r.players.values()].filter((p) => p.connected);
const roomOf = (socket) => rooms.get(socket.data.code);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickWord(r) {
  let pool = WORDS.filter(([w]) => !r.used.has(w));
  if (!pool.length) { r.used.clear(); pool = WORDS; }
  const pair = pool[Math.floor(Math.random() * pool.length)];
  r.used.add(pair[0]);
  return pair;
}

// ---------- Game flow ----------
function startRound(r) {
  clearTimeout(r.timer);
  const active = connectedPlayers(r);
  if (active.length < 2) return endGame(r);
  r.round++;
  if (r.round > r.totalRounds) return endGame(r);

  // The player who has drawn the least goes next.
  shuffle(active).sort((a, b) => a.drew - b.drew);
  const drawer = active[0];
  drawer.drew++;
  const others = active.filter((p) => p !== drawer);
  // With only 2 players there is no saboteur (a normal draw & guess game).
  const saboteur = others.length >= 2 ? others[Math.floor(Math.random() * others.length)] : null;
  const [word, decoy] = pickWord(r);

  Object.assign(r, {
    phase: 'draw', drawerId: drawer.id, saboteurId: saboteur ? saboteur.id : null, word, decoy,
    guessed: new Set(), votes: new Map(), hints: {},
    endsAt: Date.now() + DRAW_SECONDS * 1000
  });

  io.to(r.code).emit('clear');
  broadcast(r);
  io.to(drawer.id).emit('role', { role: 'drawer', word });
  if (saboteur) io.to(saboteur.id).emit('role', { role: 'saboteur', word, decoy });
  others.filter((p) => p !== saboteur).forEach((p) => io.to(p.id).emit('role', { role: 'guesser' }));
  system(r, `Round ${r.round}/${r.totalRounds}: ${drawer.name} is drawing.` + (saboteur ? ' One player is the saboteur!' : ''));
  r.timer = setTimeout(() => startVote(r), DRAW_SECONDS * 1000);
}

function startVote(r) {
  if (r.phase !== 'draw') return;
  if (!r.saboteurId) return finishRound(r); // no saboteur, no vote
  clearTimeout(r.timer);
  r.phase = 'vote';
  r.endsAt = Date.now() + VOTE_SECONDS * 1000;
  broadcast(r);
  system(r, 'Drawing is over. Vote for the saboteur!');
  r.timer = setTimeout(() => finishRound(r), VOTE_SECONDS * 1000);
}

function finishRound(r) {
  if (r.phase !== 'draw' && r.phase !== 'vote') return;
  clearTimeout(r.timer);

  const tally = {};
  for (const [voter, target] of r.votes) {
    if (voter === r.saboteurId) continue; // the saboteur's vote does not count
    tally[target] = (tally[target] || 0) + 1;
  }
  const top = Math.max(0, ...Object.values(tally));
  const sabVotes = tally[r.saboteurId] || 0;
  const caught = sabVotes > 0 && sabVotes === top;

  for (const [voter, target] of r.votes) {
    if (voter !== r.saboteurId && target === r.saboteurId) {
      const p = r.players.get(voter);
      if (p) p.score += 150;
    }
  }
  const sab = r.players.get(r.saboteurId);
  if (sab) {
    if (!caught) sab.score += 300;
    if (r.guessed.size === 0) sab.score += 100;
  }

  r.phase = 'reveal';
  r.endsAt = Date.now() + REVEAL_SECONDS * 1000;
  io.to(r.code).emit('reveal', {
    word: r.word, decoy: r.decoy, saboteurId: r.saboteurId,
    saboteurName: sab ? sab.name : '', caught, tally, guessedCount: r.guessed.size
  });
  broadcast(r);
  r.timer = setTimeout(() => startRound(r), REVEAL_SECONDS * 1000);
}

function endGame(r) {
  clearTimeout(r.timer);
  r.phase = 'end';
  r.endsAt = 0;
  broadcast(r);
}

function backToLobby(r) {
  clearTimeout(r.timer);
  for (const [id, p] of r.players) {
    if (!p.connected) r.players.delete(id);
    else { p.score = 0; p.drew = 0; }
  }
  Object.assign(r, {
    phase: 'lobby', round: 0, used: new Set(), drawerId: null, saboteurId: null,
    word: '', decoy: '', guessed: new Set(), votes: new Map(), hints: {}, endsAt: 0
  });
  io.to(r.code).emit('clear');
  broadcast(r);
}

// ---------- Sockets ----------
io.on('connection', (socket) => {
  function addPlayer(r, name) {
    r.players.set(socket.id, { id: socket.id, name: cleanName(name), score: 0, connected: true, drew: 0 });
    socket.join(r.code);
    socket.data.code = r.code;
  }

  socket.on('create', ({ name } = {}, cb) => {
    const r = newRoom(socket.id);
    rooms.set(r.code, r);
    addPlayer(r, name);
    cb && cb({ ok: true, code: r.code });
    broadcast(r);
  });

  socket.on('join', ({ name, code } = {}, cb) => {
    const r = rooms.get(String(code || '').trim().toUpperCase());
    if (!r) return cb && cb({ ok: false, error: 'Room not found. Check the code.' });
    if (r.phase !== 'lobby') return cb && cb({ ok: false, error: 'Game already started. Wait for the next game.' });
    if (r.players.size >= r.maxPlayers) return cb && cb({ ok: false, error: `Room is full (${r.maxPlayers} players max).` });
    addPlayer(r, name);
    cb && cb({ ok: true, code: r.code });
    broadcast(r);
  });

  socket.on('start', ({ rounds } = {}) => {
    const r = roomOf(socket);
    if (!r || r.host !== socket.id || r.phase !== 'lobby') return;
    if (r.players.size < r.minPlayers) return socket.emit('system', `Need at least ${r.minPlayers} players.`);
    r.totalRounds = Math.min(10, Math.max(3, Number(rounds) || 5));
    startRound(r);
  });

  // Host controls how many players are needed to start and how many can join.
  socket.on('settings', ({ min, max } = {}) => {
    const r = roomOf(socket);
    if (!r || r.host !== socket.id || r.phase !== 'lobby') return;
    const clamp = (v) => Math.min(MAX_PLAYERS, Math.max(2, Math.floor(Number(v)) || 2));
    let mx = clamp(max);
    let mn = clamp(min);
    mx = Math.max(mx, r.players.size); // cannot remove people who already joined
    mn = Math.min(mn, mx);
    r.minPlayers = mn;
    r.maxPlayers = mx;
    broadcast(r);
  });

  socket.on('playAgain', () => {
    const r = roomOf(socket);
    if (r && r.host === socket.id && r.phase === 'end') backToLobby(r);
  });

  // Drawing: only the drawer can send strokes. Coordinates are 0..1.
  socket.on('draw', (s) => {
    const r = roomOf(socket);
    if (!r || r.phase !== 'draw' || r.drawerId !== socket.id || !s) return;
    const n = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    const seg = {
      x0: n(s.x0), y0: n(s.y0), x1: n(s.x1), y1: n(s.y1),
      c: /^#[0-9a-f]{6}$/i.test(s.c) ? s.c : '#111111',
      s: Math.min(40, Math.max(1, Number(s.s) || 6))
    };
    socket.to(r.code).emit('draw', seg);
  });

  socket.on('clearBoard', () => {
    const r = roomOf(socket);
    if (r && r.phase === 'draw' && r.drawerId === socket.id) io.to(r.code).emit('clear');
  });

  // Anonymous hints: the drawer AND the saboteur can send them (2 each).
  // Nobody knows who sent a hint. Is it real, or is it a trap?
  socket.on('hint', (text) => {
    const r = roomOf(socket);
    if (!r || r.phase !== 'draw') return;
    if (socket.id !== r.drawerId && socket.id !== r.saboteurId) return;
    text = String(text || '').trim().slice(0, 40);
    if (!text) return;
    if ((r.hints[socket.id] || 0) >= 2) return socket.emit('system', 'You used both hints this round.');
    if (socket.id === r.drawerId && norm(text).includes(norm(r.word))) {
      return socket.emit('system', 'Do not write the secret word!');
    }
    r.hints[socket.id] = (r.hints[socket.id] || 0) + 1;
    io.to(r.code).emit('hint', text);
  });

  socket.on('chat', (text) => {
    const r = roomOf(socket);
    const p = r && r.players.get(socket.id);
    if (!p) return;
    text = String(text || '').trim().slice(0, 100);
    if (!text) return;

    if (r.phase === 'draw') {
      const isWord = norm(text) === norm(r.word);
      if (socket.id === r.drawerId) {
        if (norm(text).includes(norm(r.word))) return socket.emit('system', 'Do not write the secret word!');
      } else if (socket.id === r.saboteurId) {
        if (isWord) return socket.emit('system', 'You know the word. Confuse people instead!');
      } else if (r.guessed.has(socket.id)) {
        // Already guessed: only insiders see the chat, so nobody spoils the word.
        [...r.guessed, r.drawerId, r.saboteurId].forEach((id) =>
          io.to(id).emit('chat', { name: p.name, text, secret: true }));
        return;
      } else if (isWord) {
        r.guessed.add(socket.id);
        const left = Math.max(0, Math.ceil((r.endsAt - Date.now()) / 1000));
        p.score += 100 + left * 2;
        const drawer = r.players.get(r.drawerId);
        if (drawer) drawer.score += 50;
        system(r, `${p.name} guessed the word!`);
        broadcast(r);
        const guessers = connectedPlayers(r).filter((q) => q.id !== r.drawerId && q.id !== r.saboteurId);
        if (guessers.every((q) => r.guessed.has(q.id))) startVote(r);
        return;
      }
    }
    io.to(r.code).emit('chat', { name: p.name, text });
  });

  socket.on('vote', (targetId) => {
    const r = roomOf(socket);
    if (!r || r.phase !== 'vote') return;
    if (!r.players.has(targetId) || targetId === socket.id) return;
    r.votes.set(socket.id, targetId);
    broadcast(r);
    if (connectedPlayers(r).every((p) => r.votes.has(p.id))) finishRound(r);
  });

  socket.on('disconnect', () => {
    const r = roomOf(socket);
    if (!r) return;
    const p = r.players.get(socket.id);
    if (!p) return;

    if (r.phase === 'lobby' || r.phase === 'end') r.players.delete(socket.id);
    else p.connected = false;

    if (connectedPlayers(r).length === 0) {
      clearTimeout(r.timer);
      rooms.delete(r.code);
      return;
    }
    if (r.host === socket.id) r.host = connectedPlayers(r)[0].id;

    if (r.phase === 'draw' || r.phase === 'vote') {
      if (connectedPlayers(r).length < 2) return endGame(r);
      if (r.phase === 'draw' && socket.id === r.drawerId) {
        system(r, 'The drawer left. Skipping to the reveal.');
        return finishRound(r);
      }
    }
    broadcast(r);
  });
});

server.listen(PORT, () => {
  console.log(`Sketch & Sabotage running on http://localhost:${PORT} (min players: ${MIN_PLAYERS})`);
});
