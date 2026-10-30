const express    = require('express');
const http       = require('http');
const https      = require('https');
const { Server } = require('socket.io');
const os         = require('os');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

const app = express();
let server = null;
let io     = null;
let sslActive = false;

let PORT = parseInt(process.env.PORT, 10) || 7070;

// ─── Arquivos de dados ─────────────────────────────────────
const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) { console.error('Erro ao carregar users.json:', e.message); }
  return {};
}

function saveUsers(users) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) { console.error('Erro ao salvar users.json:', e.message); }
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'streamhub_s4lt_2026').digest('hex');
}

// Sessões em memória: token -> { userId, username }
const sessions = {};

function getSession(token) {
  return token ? sessions[token] : null;
}

// ─── Middlewares ───────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth endpoints ────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password)
    return res.status(400).json({ error: 'Username e senha são obrigatórios.' });

  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 20)
    return res.status(400).json({ error: 'Username deve ter entre 3 e 20 caracteres.' });
  if (!/^[a-zA-Z0-9_.\-]+$/.test(trimmed))
    return res.status(400).json({ error: 'Username só pode conter letras, números, _, - e .' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Senha deve ter no mínimo 4 caracteres.' });

  const users  = loadUsers();
  const userId = trimmed.toLowerCase();

  if (users[userId])
    return res.status(409).json({ error: 'Nome de usuário já está em uso.' });

  users[userId] = {
    username: trimmed,
    password: hashPassword(password),
    createdAt: Date.now()
  };
  saveUsers(users);

  const token = crypto.randomUUID();
  sessions[token] = { userId, username: trimmed };
  console.log(`[Auth] Novo usuário registrado: ${trimmed}`);

  res.json({ token, username: trimmed });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password)
    return res.status(400).json({ error: 'Username e senha são obrigatórios.' });

  const users  = loadUsers();
  const userId = username.trim().toLowerCase();
  const user   = users[userId];

  if (!user)
    return res.status(401).json({ error: 'Usuário não encontrado.' });
  if (user.password !== hashPassword(password))
    return res.status(401).json({ error: 'Senha incorreta.' });

  const token = crypto.randomUUID();
  sessions[token] = { userId, username: user.username };
  console.log(`[Auth] Login: ${user.username}`);

  res.json({ token, username: user.username });
});

app.get('/api/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Não autenticado.' });
  res.json({ username: session.username, userId: session.userId });
});

// ─── Network info ──────────────────────────────────────────
function getLocalIpAddresses() {
  const ifaces = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal)
        list.push({ interface: name, address: iface.address });
    }
  }
  return list;
}

app.get('/api/network-info', (req, res) => {
  const localIps = getLocalIpAddresses();
  res.json({
    port: PORT,
    localIps,
    primaryIp: localIps.length > 0 ? localIps[0].address : 'localhost'
  });
});

app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

// ─── Estado do Stream ──────────────────────────────────────
// Cada streamer conectado pode ter a própria live (multi-stream).
const streams = new Map();  // streamerSocketId -> { id, username, title, type, startedAt, viewers }
const viewers = new Map();  // viewerSocketId   -> { id, username, joinedAt, watching }

function publicStreams() {
  return Array.from(streams.values())
    .map(s => ({
      id: s.id,
      username: s.username,
      title: s.title,
      type: s.type,
      startedAt: s.startedAt,
      viewerCount: s.viewers.size
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

function broadcastStreams() {
  io.emit('streams-list', publicStreams());
}

function streamRoom(streamerId) {
  return `stream:${streamerId}`;
}

// Remove um espectador de uma live e avisa o streamer
function detachViewer(viewerId, streamerId) {
  const st = streams.get(streamerId);
  if (!st || !st.viewers.has(viewerId)) return;
  st.viewers.delete(viewerId);
  io.to(streamerId).emit('viewer-left', { viewerId });
  io.to(streamerId).emit('viewer-count', st.viewers.size);
  io.to(streamerId).emit('current-viewers', Array.from(st.viewers.values()));
  broadcastStreams();
}

// Encerra uma live (streamer parou ou desconectou)
function endStream(streamerId) {
  const st = streams.get(streamerId);
  if (!st) return;
  streams.delete(streamerId);
  st.viewers.forEach((_v, viewerId) => {
    io.to(viewerId).emit('stream-ended', { streamerId });
    const v = viewers.get(viewerId);
    if (v && v.watching === streamerId) v.watching = null;
  });
  broadcastStreams();
}

function setupSocketIo() {
  io.on('connection', (socket) => {
    // Verificar autenticação pelo token no handshake
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    const session = getSession(token);

    if (!session) {
      socket.emit('auth-error', 'Sessão inválida ou expirada. Faça login novamente.');
      socket.disconnect(true);
      return;
    }

    const { username } = session;
  console.log(`[Socket] Conectado: ${username} (${socket.id})`);

  // ── Entrar como espectador (lobby) ──────────────────────
  socket.on('join-as-viewer', () => {
    if (!viewers.has(socket.id)) {
      viewers.set(socket.id, { id: socket.id, username, joinedAt: Date.now(), watching: null });
      console.log(`[Viewer] Entrou: ${username} (${socket.id})`);
    }
    socket.emit('streams-list', publicStreams());
    io.emit('viewer-count', viewers.size);
  });

  // ── Escolher (ou sair de) uma live ──────────────────────
  socket.on('watch-stream', ({ streamerId } = {}) => {
    const v = viewers.get(socket.id) || { id: socket.id, username, joinedAt: Date.now(), watching: null };
    const previous = v.watching;

    if (previous && previous !== streamerId) {
      detachViewer(socket.id, previous);
      socket.leave(streamRoom(previous));
      v.watching = null;
    }

    if (!streamerId) {
      v.watching = null;
      viewers.set(socket.id, v);
      socket.emit('streams-list', publicStreams());
      return;
    }

    const st = streams.get(streamerId);
    if (!st) {
      v.watching = null;
      viewers.set(socket.id, v);
      socket.emit('stream-ended', { streamerId });
      socket.emit('streams-list', publicStreams());
      return;
    }

    v.watching = streamerId;
    viewers.set(socket.id, v);
    socket.join(streamRoom(streamerId));
    console.log(`[Viewer] ${username} assistindo ${st.username}`);

    if (!st.viewers.has(socket.id)) {
      st.viewers.set(socket.id, { id: socket.id, username, joinedAt: Date.now() });
      io.to(streamerId).emit('viewer-joined', { viewerId: socket.id, username });
      io.to(streamerId).emit('current-viewers', Array.from(st.viewers.values()));
      io.to(streamerId).emit('viewer-count', st.viewers.size);
      broadcastStreams();
    }

    socket.emit('stream-info', {
      id: st.id,
      username: st.username,
      title: st.title,
      type: st.type,
      startedAt: st.startedAt,
      viewerCount: st.viewers.size
    });
  });

  // Permitir que o espectador peça oferta caso ainda não tenha recebido
  socket.on('request-offer', () => {
    const v = viewers.get(socket.id);
    if (!v || !v.watching || !streams.has(v.watching)) return;
    console.log(`[Signaling] Viewer ${username} solicitou oferta WebRTC`);
    io.to(v.watching).emit('viewer-joined', { viewerId: socket.id, username });
  });

  // ── Registrar como streamer (aceita register-streamer e register-host) ──
  const handleRegisterStreamer = () => {
    console.log(`[Streamer] Registrado: ${username} (${socket.id})`);
    socket.emit('streamer-registered', { ok: true, username });
  };

  socket.on('register-streamer', handleRegisterStreamer);
  socket.on('register-host', handleRegisterStreamer);

  // ── Iniciar stream ──────────────────────────────────────
  socket.on('stream-started', (info) => {
    const stream = {
      id: socket.id,
      username,
      title: (info && info.title) || 'Transmissão ao Vivo',
      type: (info && info.type) || 'screen',
      startedAt: Date.now(),
      viewers: new Map()
    };
    streams.set(socket.id, stream);
    socket.join(streamRoom(socket.id));
    console.log(`[Stream] Iniciado por ${username}: "${stream.title}"`);
    socket.emit('stream-started-ok', { id: socket.id });
    broadcastStreams();
  });

  // ── Parar stream ────────────────────────────────────────
  socket.on('stream-stopped', () => {
    if (!streams.has(socket.id)) return;
    console.log(`[Stream] Parado por ${username}`);
    socket.leave(streamRoom(socket.id));
    endStream(socket.id);
  });

  // ── WebRTC: Oferta do Streamer ──────────────────────────
  socket.on('webrtc-offer', ({ targetId, sdp }) => {
    io.to(targetId).emit('webrtc-offer', { senderId: socket.id, sdp });
  });

  // ── WebRTC: Resposta do Viewer ──────────────────────────
  socket.on('webrtc-answer', ({ targetId, sdp }) => {
    io.to(targetId).emit('webrtc-answer', { senderId: socket.id, sdp });
  });

  // ── WebRTC: ICE Candidate ───────────────────────────────
  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice-candidate', { senderId: socket.id, candidate });
  });

  // ── Sala atual (live que este socket está assistindo/transmitindo) ──
  function currentRoom() {
    if (streams.has(socket.id)) return streamRoom(socket.id);
    const v = viewers.get(socket.id);
    return v && v.watching ? streamRoom(v.watching) : null;
  }

  // ── Chat ────────────────────────────────────────────────
  socket.on('chat-message', (data) => {
    const room = currentRoom();
    if (!room) return;
    io.to(room).emit('chat-message', {
      id: crypto.randomUUID().substring(0, 8),
      sender: username,
      isStreamer: streams.has(socket.id),
      text: String(data.text || '').substring(0, 300),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // ── Reações ─────────────────────────────────────────────
  socket.on('send-reaction', ({ emoji }) => {
    const room = currentRoom();
    if (!room) return;
    io.to(room).emit('new-reaction', { emoji: emoji || '🔥', sender: username });
  });

  // ── Desconexão ──────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[Socket] Desconectado: ${username} (${socket.id})`);

    // Era streamer? Encerra a live e avisa quem estava assistindo.
    if (streams.has(socket.id)) endStream(socket.id);

    // Era espectador? Sai da live que estava assistindo.
    const v = viewers.get(socket.id);
    if (v) {
      if (v.watching) detachViewer(socket.id, v.watching);
      viewers.delete(socket.id);
      io.emit('viewer-count', viewers.size);
    }
  });
  });
}

// ─── Inicialização com Suporte HTTPS e HTTP ─────────────────
async function initServer() {
  let sslOptions = null;
  try {
    const selfsigned = require('selfsigned');
    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: '192.168.3.141' }],
      { days: 365, keySize: 2048, algorithm: 'sha256' }
    );
    sslOptions = {
      key: pems.private,
      cert: pems.cert
    };
    sslActive = true;
  } catch (err) {
    console.warn('[SSL] Aviso: não foi possível gerar SSL nativo. Iniciando em HTTP:', err.message);
  }

  server = sslOptions ? https.createServer(sslOptions, app) : http.createServer(app);
  io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

  setupSocketIo();

  function tryListen(portToTry) {
    server.listen(portToTry, '0.0.0.0', () => {
      PORT = portToTry;
      const protocol = sslActive ? 'https' : 'http';
      const ips = getLocalIpAddresses();
      console.log('\n============================================');
      console.log(`  🚀 WatchPT — Servidor Pronto! (${protocol.toUpperCase()})`);
      console.log('============================================');
      console.log(`  🎬 App:  ${protocol}://localhost:${PORT}`);
      console.log(`  🔗 Rede: ${ips.map(i => `${protocol}://${i.address}:${PORT}`).join(' | ') || 'N/A'}`);
      console.log('============================================\n');
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        console.warn(`Porta ${portToTry} ocupada, tentando ${portToTry + 1}...`);
        tryListen(portToTry + 1);
      } else {
        console.error('Erro fatal no servidor:', err);
      }
    });
  }

  tryListen(PORT);
}

initServer();

