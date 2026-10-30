// ============================================================
// StreamHub — Frontend Application Logic
// Suporta autenticação, reprodução WebRTC e transmissão ao vivo
// ============================================================

// 1. Verificação e Inicialização de Autenticação
const appToken = localStorage.getItem('sh_token');
let currentUsername = localStorage.getItem('sh_username') || 'Usuário';

if (!appToken) {
  window.location.replace('/login.html');
}

// Configurar Socket.io com token de autenticação
const socket = io({
  auth: { token: appToken }
});

// Manipulador de erro de autenticação
socket.on('auth-error', (err) => {
  console.warn('[Auth] Erro retornado pelo socket:', err);
  localStorage.removeItem('sh_token');
  localStorage.removeItem('sh_username');
  window.location.replace('/login.html');
});

// Logout
const btnLogout = document.getElementById('btnLogout');
if (btnLogout) {
  btnLogout.addEventListener('click', () => {
    localStorage.removeItem('sh_token');
    localStorage.removeItem('sh_username');
    window.location.replace('/login.html');
  });
}

// Atualizar interface com dados do usuário
const headerUsername = document.getElementById('headerUsername');
const userInitial = document.getElementById('userInitial');
const chatUserDisplay = document.getElementById('chatUserDisplay');

if (headerUsername) headerUsername.textContent = currentUsername;
if (userInitial) userInitial.textContent = currentUsername.charAt(0).toUpperCase();
if (chatUserDisplay) chatUserDisplay.textContent = currentUsername;

// 2. Elementos DOM do Viewer
const remoteVideo = document.getElementById('remoteVideo');
const streamPlaceholder = document.getElementById('streamPlaceholder');
const placeholderTitle = document.getElementById('placeholderTitle');
const placeholderDesc = document.getElementById('placeholderDesc');
const streamTitleEl = document.getElementById('streamTitle');
const streamerByInfo = document.getElementById('streamerByInfo');
const liveBadge = document.getElementById('liveBadge');
const viewerCountEl = document.getElementById('viewerCount');
const floatingContainer = document.getElementById('floatingReactions');

// Lobby (lista de lives)
const lobbyView = document.getElementById('lobbyView');
const watchView = document.getElementById('watchView');
const lobbyGrid = document.getElementById('lobbyGrid');
const lobbyEmpty = document.getElementById('lobbyEmpty');
const lobbySubtitle = document.getElementById('lobbySubtitle');
const btnBackLobby = document.getElementById('btnBackLobby');
const btnRefreshLobby = document.getElementById('btnRefreshLobby');

const ICON_PLAY = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const ICON_PAUSE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

// Controles de vídeo
const btnPlayPause = document.getElementById('btnPlayPause');
const btnMute = document.getElementById('btnMute');
const volumeSlider = document.getElementById('volumeSlider');
const btnFullscreen = document.getElementById('btnFullscreen');
const btnPip = document.getElementById('btnPip');
const unmuteBanner = document.getElementById('unmuteBanner');

// Chat e Reações
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const reactionButtons = document.querySelectorAll('.reaction-btn');

// Elementos do Estúdio / Transmissor
const studioModal = document.getElementById('studioModal');
const btnToggleStudio = document.getElementById('btnToggleStudio');
const btnCloseStudio = document.getElementById('btnCloseStudio');
const transmitBtnText = document.getElementById('transmitBtnText');

const btnStudioScreen = document.getElementById('btnStudioScreen');
const btnStudioVideo = document.getElementById('btnStudioVideo');
const btnStudioCamera = document.getElementById('btnStudioCamera');
const studioFileInputWrapper = document.getElementById('studioFileInputWrapper');
const studioVideoFileInput = document.getElementById('studioVideoFileInput');
const studioTitleInput = document.getElementById('studioTitleInput');
const studioPreviewBox = document.getElementById('studioPreviewBox');
const studioPreviewVideo = document.getElementById('studioPreviewVideo');
const btnStudioStart = document.getElementById('btnStudioStart');
const btnStudioStop = document.getElementById('btnStudioStop');

const modalShareableUrlCode = document.getElementById('modalShareableUrlCode');
const btnModalCopyLink = document.getElementById('btnModalCopyLink');
const btnHeaderShare = document.getElementById('btnHeaderShare');

// 3. Estado da Aplicação
let viewerPeerConn = null;
let viewerIceQueue = [];

let activeStreams = [];
let watchingStreamId = null;

let isBroadcaster = false;
let broadcasterStream = null;
let broadcasterSourceType = 'screen'; // 'screen' | 'video' | 'camera'
const broadcasterPeers = new Map(); // viewerId -> RTCPeerConnection
const broadcasterIceQueues = new Map(); // viewerId -> [candidate]

let networkShareUrl = window.location.origin;

// 4. Carregar informações de IP de Rede para compartilhamento
async function loadNetworkInfo() {
  try {
    const res = await fetch('/api/network-info');
    if (res.ok) {
      const data = await res.json();
      networkShareUrl = `http://${data.primaryIp}:${data.port}`;
    }
  } catch (e) {
    networkShareUrl = window.location.origin;
  }
  if (modalShareableUrlCode) modalShareableUrlCode.textContent = networkShareUrl;
}
loadNetworkInfo();

function copyShareLink() {
  navigator.clipboard.writeText(networkShareUrl).then(() => {
    showToast('Link de acesso copiado! Envie para seus amigos.', 'success');
  }).catch(() => {
    showToast(`Copie o link: ${networkShareUrl}`, 'info');
  });
}

if (btnModalCopyLink) btnModalCopyLink.addEventListener('click', copyShareLink);
if (btnHeaderShare) btnHeaderShare.addEventListener('click', copyShareLink);

// 5. Controle do Modal do Estúdio
function openStudioModal() {
  studioModal.classList.add('open');
}

function closeStudioModal() {
  studioModal.classList.remove('open');
}

if (btnToggleStudio) btnToggleStudio.addEventListener('click', openStudioModal);
if (btnCloseStudio) btnCloseStudio.addEventListener('click', closeStudioModal);

// Fechar modal ao clicar fora
if (studioModal) {
  studioModal.addEventListener('click', (e) => {
    if (e.target === studioModal) closeStudioModal();
  });
}

// 6. Seleção de Tipo de Fonte de Transmissão
if (btnStudioScreen) {
  btnStudioScreen.addEventListener('click', () => setSourceType('screen'));
}
if (btnStudioVideo) {
  btnStudioVideo.addEventListener('click', () => setSourceType('video'));
}
if (btnStudioCamera) {
  btnStudioCamera.addEventListener('click', () => setSourceType('camera'));
}

function setSourceType(type) {
  broadcasterSourceType = type;
  [btnStudioScreen, btnStudioVideo, btnStudioCamera].forEach(b => b && b.classList.remove('active'));

  if (type === 'screen') {
    btnStudioScreen.classList.add('active');
    studioFileInputWrapper.classList.remove('active');
  } else if (type === 'video') {
    btnStudioVideo.classList.add('active');
    studioFileInputWrapper.classList.add('active');
  } else if (type === 'camera') {
    btnStudioCamera.classList.add('active');
    studioFileInputWrapper.classList.remove('active');
  }
}

// 7. Obter Mídia para Transmissão
async function captureBroadcasterStream() {
  if (broadcasterSourceType === 'screen') {
    return await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        frameRate: { ideal: 60, max: 60 }
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
  } else if (broadcasterSourceType === 'camera') {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: true
    });
  } else if (broadcasterSourceType === 'video') {
    const file = studioVideoFileInput.files[0];
    if (!file) throw new Error('Selecione um arquivo de vídeo do seu computador.');

    const tempVideo = document.createElement('video');
    tempVideo.src = URL.createObjectURL(file);
    tempVideo.loop = true;
    tempVideo.playsInline = true;
    tempVideo.muted = false;

    await tempVideo.play();

    let stream = null;
    if (tempVideo.captureStream) {
      stream = tempVideo.captureStream(60);
    } else if (tempVideo.mozCaptureStream) {
      stream = tempVideo.mozCaptureStream(60);
    } else {
      throw new Error('Seu navegador não suporta captura direta de arquivo de vídeo.');
    }
    return stream;
  }
}

// 8. Iniciar Transmissão
if (btnStudioStart) {
  btnStudioStart.addEventListener('click', async () => {
    try {
      btnStudioStart.disabled = true;
      btnStudioStart.innerHTML = 'Conectando fonte...';

      // Capturar stream
      broadcasterStream = await captureBroadcasterStream();

      // Monitor de prévia local
      if (studioPreviewVideo) {
        studioPreviewVideo.srcObject = broadcasterStream;
        studioPreviewBox.style.display = 'block';
      }

      // Se o usuário fechar a tela compartilhada pelo navegador
      broadcasterStream.getVideoTracks().forEach(track => {
        track.onended = () => stopBroadcasting();
      });

      // Solicitar registro como streamer no socket
      socket.emit('register-streamer');

      const streamTitle = (studioTitleInput && studioTitleInput.value.trim()) || 'Transmissão ao Vivo';

      socket.emit('stream-started', {
        title: streamTitle,
        type: broadcasterSourceType
      });

      isBroadcaster = true;
      updateBroadcasterUI(true);
      showToast('Transmissão ao vivo iniciada com sucesso!', 'live');
      closeStudioModal();

    } catch (err) {
      console.error('[Streamer] Erro ao iniciar transmissão:', err);
      if (err.name !== 'NotAllowedError') {
        showToast(err.message || 'Erro ao capturar transmissão.', 'error');
      }
      stopBroadcasting();
    } finally {
      btnStudioStart.disabled = false;
      btnStudioStart.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg> Começar a Transmitir`;
    }
  });
}

function updateBroadcasterUI(live) {
  if (live) {
    btnStudioStart.style.display = 'none';
    btnStudioStop.style.display = 'flex';
    btnToggleStudio.classList.add('active');
    transmitBtnText.textContent = 'Transmitindo (Painel)';
  } else {
    btnStudioStart.style.display = 'flex';
    btnStudioStop.style.display = 'none';
    btnToggleStudio.classList.remove('active');
    transmitBtnText.textContent = 'Iniciar Transmissão';
    if (studioPreviewBox) studioPreviewBox.style.display = 'none';
    if (studioPreviewVideo) studioPreviewVideo.srcObject = null;
  }
}

// 9. Parar Transmissão
function stopBroadcasting() {
  if (broadcasterStream) {
    broadcasterStream.getTracks().forEach(track => track.stop());
    broadcasterStream = null;
  }

  // Fechar conexões P2P com todos os espectadores
  broadcasterPeers.forEach((pc) => {
    try { pc.close(); } catch(e){}
  });
  broadcasterPeers.clear();
  broadcasterIceQueues.clear();

  if (isBroadcaster) {
    socket.emit('stream-stopped');
    isBroadcaster = false;
    showToast('Transmissão encerrada.', 'info');
  }

  updateBroadcasterUI(false);
}

if (btnStudioStop) {
  btnStudioStop.addEventListener('click', () => {
    stopBroadcasting();
    closeStudioModal();
  });
}

// 10. WebRTC do Broadcaster: Quando um espectador se conecta
socket.on('viewer-joined', async ({ viewerId, username: vUser }) => {
  if (!isBroadcaster || !broadcasterStream) return;
  console.log(`[Broadcaster] Novo espectador: ${vUser} (${viewerId}). Criando PeerConnection...`);

  // Se já tinha conexão com esse viewer, fechar
  if (broadcasterPeers.has(viewerId)) {
    try { broadcasterPeers.get(viewerId).close(); } catch(e){}
    broadcasterPeers.delete(viewerId);
  }
  broadcasterIceQueues.set(viewerId, []);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  broadcasterPeers.set(viewerId, pc);

  // Adicionar todas as tracks de áudio e vídeo
  broadcasterStream.getTracks().forEach(track => {
    pc.addTrack(track, broadcasterStream);
  });

  // ICE candidates do Broadcaster para este espectador
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', {
        targetId: viewerId,
        candidate: event.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[Broadcaster] Estado com ${vUser}: ${pc.connectionState}`);
  };

  try {
    const offer = await pc.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false
    });
    await pc.setLocalDescription(offer);

    socket.emit('webrtc-offer', {
      targetId: viewerId,
      sdp: pc.localDescription
    });
  } catch (err) {
    console.error(`[Broadcaster] Erro ao criar oferta para ${vUser}:`, err);
  }
});

// Resposta WebRTC do Viewer para o Broadcaster
socket.on('webrtc-answer', async ({ senderId, sdp }) => {
  if (!isBroadcaster) return;
  const pc = broadcasterPeers.get(senderId);
  if (!pc) return;

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    // Processar fila de ICE candidates recebidos antes do remote description
    const queue = broadcasterIceQueues.get(senderId) || [];
    while (queue.length > 0) {
      const candidate = queue.shift();
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('[Broadcaster] Erro ao processar resposta do viewer:', err);
  }
});

// ICE candidate enviado pelo Viewer ao Broadcaster
socket.on('webrtc-ice-candidate', async ({ senderId, candidate }) => {
  if (isBroadcaster) {
    const pc = broadcasterPeers.get(senderId);
    if (!pc) return;

    if (pc.remoteDescription) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('[Broadcaster] Erro ao adicionar ICE candidate:', err);
      }
    } else {
      const queue = broadcasterIceQueues.get(senderId) || [];
      queue.push(candidate);
      broadcasterIceQueues.set(senderId, queue);
    }
  } else {
    // Caso de uso: receptor é o Viewer
    if (viewerPeerConn && viewerPeerConn.remoteDescription) {
      try {
        await viewerPeerConn.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('[Viewer] Erro ao adicionar ICE candidate:', err);
      }
    } else {
      viewerIceQueue.push(candidate);
    }
  }
});

// Espectador desconectou
socket.on('viewer-left', ({ viewerId }) => {
  if (broadcasterPeers.has(viewerId)) {
    try { broadcasterPeers.get(viewerId).close(); } catch(e){}
    broadcasterPeers.delete(viewerId);
    broadcasterIceQueues.delete(viewerId);
  }
});

// Conflito de streamer
socket.on('streamer-conflict', ({ message }) => {
  showToast(message, 'error');
  stopBroadcasting();
});

// ============================================================
// 11. Lobby de Lives + Lógica do Espectador (Viewer)
// ============================================================

let currentStreamMeta = null;

function showLobby() {
  lobbyView.classList.remove('is-hidden');
  watchView.classList.add('is-hidden');
}

function showWatch() {
  lobbyView.classList.add('is-hidden');
  watchView.classList.remove('is-hidden');
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'agora';
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  return `há ${h}h`;
}

function buildLiveCard(stream) {
  const isMine = stream.username === currentUsername;
  const initial = (stream.username || '?').charAt(0).toUpperCase();
  const started = stream.startedAt ? timeAgo(stream.startedAt) : '';

  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'live-card';
  card.dataset.streamId = stream.id;
  card.innerHTML = `
    <span class="live-card-avatar">${escapeHtml(initial)}</span>
    <span class="live-card-body">
      <span class="live-card-top">
        <span class="live-card-user">${escapeHtml(stream.username)}</span>
        <span class="live-card-badge"><span class="pulse-dot"></span>AO VIVO</span>
      </span>
      <span class="live-card-title">${escapeHtml(stream.title)}</span>
      <span class="live-card-meta">
        <span>👁 ${stream.viewerCount || 0} ${stream.viewerCount === 1 ? 'espectador' : 'espectadores'}</span>
        ${started ? `<span>· ${started}</span>` : ''}
        ${isMine ? '<span class="live-card-mine">· sua live</span>' : ''}
      </span>
    </span>
    <span class="live-card-play">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    </span>
  `;

  card.addEventListener('click', () => {
    if (isMine) {
      showToast('Você é quem está transmitindo esta live.', 'info');
      openStudioModal();
      return;
    }
    startWatching(stream);
  });

  return card;
}

function renderLobby() {
  if (!lobbyGrid) return;
  lobbyGrid.innerHTML = '';

  if (!activeStreams.length) {
    lobbyEmpty.classList.remove('is-hidden');
    lobbySubtitle.textContent = 'Nenhuma transmissão ativa no momento';
    return;
  }

  lobbyEmpty.classList.add('is-hidden');
  lobbySubtitle.textContent = activeStreams.length === 1
    ? '1 live disponível — clique para assistir'
    : `${activeStreams.length} lives disponíveis — clique para assistir`;
  activeStreams.forEach(s => lobbyGrid.appendChild(buildLiveCard(s)));
}

function startWatching(stream) {
  watchingStreamId = stream.id;
  currentStreamMeta = stream;

  closeViewerPeer();

  if (streamTitleEl) streamTitleEl.textContent = stream.title;
  if (streamerByInfo) streamerByInfo.innerHTML = `Transmitido por <strong>${escapeHtml(stream.username)}</strong> · P2P WebRTC`;
  remoteVideo.srcObject = null;
  streamPlaceholder.classList.remove('hidden');
  placeholderTitle.textContent = 'Conectando à live...';
  placeholderDesc.textContent = 'Aguarde enquanto a transmissão é estabelecida.';

  showWatch();
  socket.emit('watch-stream', { streamerId: stream.id });

  setTimeout(() => {
    if (watchingStreamId === stream.id && !remoteVideo.srcObject) {
      socket.emit('request-offer');
    }
  }, 1200);
}

function closeViewerPeer() {
  if (viewerPeerConn) {
    try { viewerPeerConn.close(); } catch (e) {}
    viewerPeerConn = null;
  }
  viewerIceQueue = [];
}

function stopWatching() {
  if (watchingStreamId) {
    socket.emit('watch-stream', { streamerId: null });
    watchingStreamId = null;
  }
  currentStreamMeta = null;
  closeViewerPeer();
  remoteVideo.srcObject = null;
  if (btnPlayPause) btnPlayPause.innerHTML = ICON_PLAY;
  showLobby();
}

if (btnBackLobby) btnBackLobby.addEventListener('click', stopWatching);
if (btnRefreshLobby) btnRefreshLobby.addEventListener('click', () => socket.emit('join-as-viewer'));

// Registrar como espectador para receber a lista de lives
// (reemite ao reconectar, para o socket.id novo voltar a receber a lista)
socket.on('connect', () => {
  socket.emit('join-as-viewer');
  if (watchingStreamId) socket.emit('watch-stream', { streamerId: watchingStreamId });
});
socket.emit('join-as-viewer');
showLobby();
renderLobby();

// Lista de lives atualizada pelo servidor
socket.on('streams-list', (list) => {
  activeStreams = Array.isArray(list) ? list : [];

  if (watchingStreamId) {
    const meta = activeStreams.find(s => s.id === watchingStreamId);
    if (meta) {
      currentStreamMeta = meta;
      if (streamTitleEl) streamTitleEl.textContent = meta.title;
    }
  }

  renderLobby();

  if (activeStreams.length > 0) {
    liveBadge.classList.remove('offline');
    liveBadge.innerHTML = `<span class="pulse-dot"></span> AO VIVO`;
  } else {
    liveBadge.classList.add('offline');
    liveBadge.innerHTML = `<span class="pulse-dot"></span> OFFLINE`;
  }

  if (watchingStreamId && !activeStreams.some(s => s.id === watchingStreamId)) {
    if (currentStreamMeta) showToast('A live que você assistia foi encerrada.', 'info');
    stopWatching();
  }
});

// Confirmação de que a live escolhida existe
socket.on('stream-info', (stream) => {
  if (!stream || stream.id !== watchingStreamId) return;
  currentStreamMeta = stream;
  if (streamTitleEl) streamTitleEl.textContent = stream.title;
  if (streamerByInfo) streamerByInfo.innerHTML = `Transmitido por <strong>${escapeHtml(stream.username)}</strong> · P2P WebRTC`;
});

// A live que estou assistindo foi encerrada
socket.on('stream-ended', ({ streamerId } = {}) => {
  if (!watchingStreamId) return;
  if (streamerId && streamerId !== watchingStreamId) return;
  showToast('A transmissão foi encerrada.', 'info');
  stopWatching();
});

// Ao começar a transmitir, sai da live que estiver assistindo
socket.on('stream-started-ok', () => {
  if (watchingStreamId) stopWatching();
});


// Quantidade de espectadores
socket.on('viewer-count', (count) => {
  if (viewerCountEl) viewerCountEl.textContent = count;
});

// Receber oferta WebRTC do Broadcaster
socket.on('webrtc-offer', async ({ senderId, sdp }) => {
  if (!watchingStreamId || senderId !== watchingStreamId) return; // Só aceita a live que estou assistindo

  console.log('[Viewer] Oferta WebRTC recebida do Broadcaster...');

  try {
    if (viewerPeerConn) {
      viewerPeerConn.close();
      viewerPeerConn = null;
    }
    viewerIceQueue = [];

    viewerPeerConn = new RTCPeerConnection(RTC_CONFIG);

    viewerPeerConn.ontrack = (event) => {
      console.log('[Viewer] Feed recebido:', event.track.kind);
      if (event.streams && event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        streamPlaceholder.classList.add('hidden');
        liveBadge.classList.remove('offline');
        liveBadge.innerHTML = `<span class="pulse-dot"></span> AO VIVO`;

        const playPromise = remoteVideo.play();
        if (playPromise !== undefined) {
          playPromise.catch(() => {
            if (unmuteBanner) unmuteBanner.style.display = 'flex';
          });
        }
      }
    };

    viewerPeerConn.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-ice-candidate', {
          targetId: senderId,
          candidate: event.candidate
        });
      }
    };

    await viewerPeerConn.setRemoteDescription(new RTCSessionDescription(sdp));

    // Processar fila de ICE candidates
    while (viewerIceQueue.length > 0) {
      const candidate = viewerIceQueue.shift();
      await viewerPeerConn.addIceCandidate(new RTCIceCandidate(candidate));
    }

    // Criar resposta
    const answer = await viewerPeerConn.createAnswer();
    await viewerPeerConn.setLocalDescription(answer);

    socket.emit('webrtc-answer', {
      targetId: senderId,
      sdp: viewerPeerConn.localDescription
    });

  } catch (err) {
    console.error('[Viewer] Erro ao aceitar oferta WebRTC:', err);
  }
});

// Controles do reprodutor de vídeo
if (btnPlayPause) {
  btnPlayPause.addEventListener('click', () => {
    if (!remoteVideo.srcObject) return;
    if (remoteVideo.paused) {
      remoteVideo.play();
      btnPlayPause.innerHTML = ICON_PAUSE;
    } else {
      remoteVideo.pause();
      btnPlayPause.innerHTML = ICON_PLAY;
    }
  });
}

if (btnMute) {
  btnMute.addEventListener('click', () => {
    remoteVideo.muted = !remoteVideo.muted;
    updateMuteUI();
  });
}

if (volumeSlider) {
  volumeSlider.addEventListener('input', () => {
    remoteVideo.volume = volumeSlider.value;
    remoteVideo.muted = volumeSlider.value === '0';
    updateMuteUI();
  });
}

function updateMuteUI() {
  if (!btnMute) return;
  if (remoteVideo.muted || remoteVideo.volume === 0) {
    btnMute.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
  } else {
    btnMute.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
  }
}

if (unmuteBanner) {
  unmuteBanner.addEventListener('click', () => {
    remoteVideo.muted = false;
    remoteVideo.play();
    unmuteBanner.style.display = 'none';
    updateMuteUI();
  });
}

if (btnFullscreen) {
  btnFullscreen.addEventListener('click', () => {
    const theater = document.querySelector('.video-theater');
    if (!document.fullscreenElement) {
      if (theater.requestFullscreen) theater.requestFullscreen();
      else if (remoteVideo.requestFullscreen) remoteVideo.requestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  });
}

if (btnPip) {
  btnPip.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (remoteVideo !== document.pictureInPictureElement) {
        await remoteVideo.requestPictureInPicture();
      }
    } catch (e) {
      showToast('Picture-in-Picture não suportado neste navegador.', 'error');
    }
  });
}

// ============================================================
// 12. Chat e Reações
// ============================================================
if (chatForm && chatInput) {
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;

    socket.emit('chat-message', { text });
    chatInput.value = '';
  });
}

socket.on('chat-message', (data) => {
  if (!chatMessages) return;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';

  const isMe = data.sender === currentUsername;
  const streamerBadge = data.isStreamer ? `<span class="streamer-badge-chat">👑 Streamer</span>` : '';

  bubble.innerHTML = `
    <div class="bubble-meta">
      <span class="bubble-sender" style="${isMe ? 'color:var(--text-white);font-weight:700;' : ''}">${escapeHtml(data.sender)}${streamerBadge}</span>
      <span class="bubble-time">${data.timestamp}</span>
    </div>
    <div class="bubble-text">${escapeHtml(data.text)}</div>
  `;

  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// Reações com emojis
reactionButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const emoji = btn.getAttribute('data-emoji');
    socket.emit('send-reaction', { emoji });
    spawnFloatingEmoji(emoji, floatingContainer);
  });
});

socket.on('new-reaction', ({ emoji }) => {
  spawnFloatingEmoji(emoji, floatingContainer);
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
