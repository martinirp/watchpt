const express    = require('express');
const http       = require('http');
const https      = require('https');
const { Server } = require('socket.io');
const os         = require('os');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

const app = express();

// ─── Certificados SSL automáticos para HTTPS ────────────────
let sslOptions = null;
try {
  const selfsigned = require('selfsigned');
  const attrs = [{ name: 'commonName', value: 'watchpt.local' }];
  const pems = selfsigned.generate(attrs, { days: 365 });
  sslOptions = { key: pems.private, cert: pems.cert };
} catch (e) {
  console.warn('[HTTPS] Módulo selfsigned não disponível, rodando apenas HTTP:', e.message);
}

// Servidor principal: HTTPS se disponível, senão HTTP
const server = sslOptions ? https.createServer(sslOptions, app) : http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

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
let streamerSocketId = null;
let streamerUsername = null;
let streamInfo = {
  isLive: false,
  title: 'Transmissão ao Vivo',
  username: null,
  type: 'screen',
  startedAt: null
};

const viewers = new Map();        // socketId -> { id, username }

// ─── Socket.io ─────────────────────────────────────────────
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

  // ── Entrar como espectador ──────────────────────────────
  socket.on('join-as-viewer', () => {
    viewers.set(socket.id, { id: socket.id, username, joinedAt: Date.now() });
    socket.join('viewers');
    console.log(`[Viewer] Entrou: ${username} (${socket.id})`);

    // Informar estado atual do stream
    socket.emit('stream-status', {
      ...streamInfo,
      hostAvailable: !!streamerSocketId,
      streamerUsername
    });

    // Se a live já está rolando, pedir para o streamer criar a oferta para este viewer
    if (streamerSocketId && streamInfo.isLive && streamerSocketId !== socket.id) {
      io.to(streamerSocketId).emit('viewer-joined', { viewerId: socket.id, username });
    }

    io.emit('viewer-count', viewers.size);
    io.emit('viewers-list', Array.from(viewers.values()));
  });

  // Permitir que o espectador peça oferta caso ainda não tenha recebido
  socket.on('request-offer', () => {
    if (streamerSocketId && streamInfo.isLive && socket.id !== streamerSocketId) {
      console.log(`[Signaling] Viewer ${username} solicitou oferta WebRTC`);
      io.to(streamerSocketId).emit('viewer-joined', { viewerId: socket.id, username });
    }
  });

  // ── Registrar como streamer (aceita register-streamer e register-host) ──
  const handleRegisterStreamer = () => {
    if (streamerSocketId && streamerSocketId !== socket.id) {
      socket.emit('streamer-conflict', {
        message: `${streamerUsername} já está transmitindo no momento. Aguarde ele terminar.`
      });
      return;
    }
    streamerSocketId = socket.id;
    streamerUsername = username;
    console.log(`[Streamer] Registrado: ${username} (${socket.id})`);
    socket.emit('streamer-registered', { ok: true, username });
    io.emit('stream-status', {
      ...streamInfo,
      hostAvailable: true,
      streamerUsername
    });
  };

  socket.on('register-streamer', handleRegisterStreamer);
  socket.on('register-host', handleRegisterStreamer);

  // ── Iniciar stream ──────────────────────────────────────
  socket.on('stream-started', (info) => {
    if (socket.id !== streamerSocketId) {
      // Se não estava registrado ainda, registrar agora
      streamerSocketId = socket.id;
      streamerUsername = username;
    }

    streamInfo = {
      isLive: true,
      title: (info && info.title) || 'Transmissão ao Vivo',
      username,
      type: (info && info.type) || 'screen',
      startedAt: Date.now()
    };
    console.log(`[Stream] Iniciado por ${username}: "${streamInfo.title}"`);
    io.emit('stream-status', {
      ...streamInfo,
      hostAvailable: true,
      streamerUsername: username
    });

    // Conectar a TODOS os espectadores atualmente conectados!
    viewers.forEach((v, vSocketId) => {
      if (vSocketId !== streamerSocketId) {
        socket.emit('viewer-joined', { viewerId: vSocketId, username: v.username });
      }
    });
  });

  // ── Parar stream ────────────────────────────────────────
  socket.on('stream-stopped', () => {
    if (socket.id !== streamerSocketId) return;
    streamInfo = { isLive: false, title: streamInfo.title, username: null, type: 'screen', startedAt: null };
    streamerSocketId = null;
    streamerUsername = null;
    console.log(`[Stream] Parado por ${username}`);
    io.emit('stream-status', {
      ...streamInfo,
      hostAvailable: false,
      streamerUsername: null
    });
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

  // ── Chat ────────────────────────────────────────────────
  socket.on('chat-message', (data) => {
    const isStreamer = socket.id === streamerSocketId;
    io.emit('chat-message', {
      id: crypto.randomUUID().substring(0, 8),
      sender: username,
      isStreamer,
      text: String(data.text || '').substring(0, 300),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // ── Reações ─────────────────────────────────────────────
  socket.on('send-reaction', ({ emoji }) => {
    io.emit('new-reaction', { emoji: emoji || '🔥', sender: username });
  });

  // ── Desconexão ──────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[Socket] Desconectado: ${username} (${socket.id})`);

    if (socket.id === streamerSocketId) {
      streamerSocketId = null;
      streamerUsername = null;
      streamInfo.isLive = false;
      streamInfo.username = null;
      io.emit('stream-status', { ...streamInfo, hostAvailable: false });
    }

    if (viewers.has(socket.id)) {
      viewers.delete(socket.id);
      // Notificar streamer para limpar peer
      if (streamerSocketId) {
        io.to(streamerSocketId).emit('viewer-left', { viewerId: socket.id });
      }
      io.emit('viewer-count', viewers.size);
      io.emit('viewers-list', Array.from(viewers.values()));
    }
  });
});

// ─── Iniciar servidor com auto-fallback de porta ───────────
function startServer(portToTry) {
  server.listen(portToTry, '0.0.0.0', () => {
    PORT = portToTry;
    const protocol = sslOptions ? 'https' : 'http';
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
      startServer(portToTry + 1);
    } else {
      console.error('Erro fatal no servidor:', err);
    }
  });
}

startServer(PORT);
