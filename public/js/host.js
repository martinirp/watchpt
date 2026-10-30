const token = localStorage.getItem('sh_token');
if (!token) {
  window.location.replace('/login.html');
}

const socket = io({
  auth: { token }
});

socket.on('auth-error', () => {
  localStorage.removeItem('sh_token');
  localStorage.removeItem('sh_username');
  window.location.replace('/login.html');
});

// Estado do Host
let currentStream = null;
let currentSourceType = 'screen'; // 'screen' | 'video' | 'camera'
const peerConnections = new Map(); // viewerId -> RTCPeerConnection
const iceCandidateQueues = new Map(); // viewerId -> [candidate, ...] (buffer antes de setRemoteDescription)
const pendingViewers = new Map(); // viewerId -> username (viewers esperando stream iniciar)
let streamStartTime = null;
let statsInterval = null;

// Elementos DOM
const localPreview = document.getElementById('localPreview');
const localVideoElement = document.getElementById('localVideoElement');
const btnStartStream = document.getElementById('btnStartStream');
const btnStopStream = document.getElementById('btnStopStream');
const btnScreenSource = document.getElementById('btnScreenSource');
const btnVideoSource = document.getElementById('btnVideoSource');
const btnCameraSource = document.getElementById('btnCameraSource');
const fileInputWrapper = document.getElementById('fileInputWrapper');
const videoFileInput = document.getElementById('videoFileInput');
const streamTitleInput = document.getElementById('streamTitleInput');
const hostStatusBadge = document.getElementById('hostStatusBadge');
const viewerCountEl = document.getElementById('viewerCount');
const viewersListContainer = document.getElementById('viewersList');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const shareableUrlCode = document.getElementById('shareableUrlCode');
const resolutionBadge = document.getElementById('resolutionBadge');

// Chat e Reações
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const floatingContainer = document.getElementById('floatingReactions');

// 1. Obter informações de IP do servidor para exibir o link correto
async function loadNetworkInfo() {
  try {
    const res = await fetch('/api/network-info');
    const data = await res.json();
    const port = data.port;
    const ip = data.primaryIp;
    const shareUrl = `http://${ip}:${port}`;
    if (shareableUrlCode) {
      shareableUrlCode.textContent = shareUrl;
    }
  } catch (err) {
    console.warn('Erro ao obter IP do servidor:', err);
    if (shareableUrlCode) {
      shareableUrlCode.textContent = window.location.origin;
    }
  }
}
loadNetworkInfo();

// Copiar link com 1 clique
if (copyLinkBtn) {
  copyLinkBtn.addEventListener('click', () => {
    const textToCopy = shareableUrlCode.textContent;
    navigator.clipboard.writeText(textToCopy).then(() => {
      showToast('Link de acesso copiado com sucesso!', 'success');
    }).catch(() => {
      showToast('Não foi possível copiar automaticamente.', 'error');
    });
  });
}

// 2. Conectar e registrar como Host
socket.emit('register-host');

socket.on('connect', () => {
  console.log('[Host] Conectado ao servidor de sinalização');
  showToast('Painel do Transmissor conectado!', 'success');
});

// 3. Seleção de Tipo de Fonte de Mídia
btnScreenSource.addEventListener('click', () => {
  setSourceType('screen');
});

btnVideoSource.addEventListener('click', () => {
  setSourceType('video');
});

btnCameraSource.addEventListener('click', () => {
  setSourceType('camera');
});

function setSourceType(type) {
  currentSourceType = type;
  [btnScreenSource, btnVideoSource, btnCameraSource].forEach(btn => btn.classList.remove('active'));

  if (type === 'screen') {
    btnScreenSource.classList.add('active');
    fileInputWrapper.classList.remove('active');
  } else if (type === 'video') {
    btnVideoSource.classList.add('active');
    fileInputWrapper.classList.add('active');
  } else if (type === 'camera') {
    btnCameraSource.classList.add('active');
    fileInputWrapper.classList.remove('active');
  }
}

// Se o usuário selecionar um arquivo de vídeo local
videoFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    const fileUrl = URL.createObjectURL(file);
    localVideoElement.src = fileUrl;
    localVideoElement.style.display = 'block';
    localPreview.style.display = 'none';
    showToast(`Arquivo "${file.name}" carregado. Clique em "Iniciar Transmissão"!`, 'info');
  }
});

// 4. Iniciar Transmissão
btnStartStream.addEventListener('click', async () => {
  try {
    let stream = null;

    if (currentSourceType === 'screen') {
      // Captura de tela com áudio (se selecionado pelo usuário no navegador)
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',
          frameRate: { ideal: 30, max: 60 },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
    } else if (currentSourceType === 'video') {
      if (!localVideoElement.src) {
        showToast('Selecione um arquivo de vídeo primeiro!', 'error');
        return;
      }
      localVideoElement.play();
      // Captura o stream do vídeo HTML5
      stream = localVideoElement.captureStream ? localVideoElement.captureStream() : localVideoElement.mozCaptureStream();
    } else if (currentSourceType === 'camera') {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: true
      });
    }

    if (!stream) {
      showToast('Nenhuma fonte de transmissão disponível.', 'error');
      return;
    }

    currentStream = stream;

    // Conectar à pré-visualização local
    if (currentSourceType !== 'video') {
      localVideoElement.style.display = 'none';
      localPreview.style.display = 'block';
      localPreview.srcObject = currentStream;
      localPreview.muted = true; // Para evitar eco no próprio fone do host
      localPreview.play();
    }

    // Ouvir se o compartilhamento for interrompido pelo botão nativo do navegador
    currentStream.getVideoTracks().forEach(track => {
      track.onended = () => {
        stopStreaming();
      };
    });

    // Atualizar UI
    btnStartStream.style.display = 'none';
    btnStopStream.style.display = 'flex';
    hostStatusBadge.classList.remove('offline');
    hostStatusBadge.innerHTML = `<span class="pulse-dot"></span> AO VIVO`;

    // Atualizar info de resolução
    const vTrack = currentStream.getVideoTracks()[0];
    if (vTrack) {
      const settings = vTrack.getSettings();
      if (resolutionBadge && settings.width && settings.height) {
        resolutionBadge.textContent = `${settings.width}x${settings.height}`;
      }
    }

    // Avisar o servidor que o stream começou
    const title = streamTitleInput.value.trim() || 'Transmissão ao Vivo';
    socket.emit('stream-started', {
      title,
      type: currentSourceType
    });

    showToast('Transmissão iniciada com sucesso!', 'live');

    // Conectar viewers que estavam esperando (pendingViewers)
    for (const [viewerId, username] of pendingViewers.entries()) {
      console.log(`[Host] Conectando viewer pendente: ${username} (${viewerId})`);
      setupPeerConnection(viewerId);
    }
    pendingViewers.clear();

    // Reconectar viewers que já tinham conexão aberta (ex: segundo start)
    for (const [viewerId] of peerConnections.entries()) {
      setupPeerConnection(viewerId);
    }

  } catch (err) {
    console.error('Erro ao iniciar transmissão:', err);
    if (err.name !== 'NotAllowedError') {
      showToast('Erro ao capturar mídia: ' + err.message, 'error');
    }
  }
});

// Parar Transmissão
btnStopStream.addEventListener('click', () => {
  stopStreaming();
});

function stopStreaming() {
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }

  if (currentSourceType === 'video') {
    localVideoElement.pause();
  }

  localPreview.srcObject = null;

  // Fechar conexões WebRTC ativas
  for (const [viewerId, pc] of peerConnections.entries()) {
    pc.close();
  }
  peerConnections.clear();

  // Atualizar UI
  btnStartStream.style.display = 'flex';
  btnStopStream.style.display = 'none';
  hostStatusBadge.classList.add('offline');
  hostStatusBadge.innerHTML = `<span class="pulse-dot"></span> OFFLINE`;
  if (resolutionBadge) resolutionBadge.textContent = 'Sem sinal';

  socket.emit('stream-stopped');
  showToast('Transmissão encerrada.', 'info');
}

// 5. Gerenciamento WebRTC com Espectadores
// Quando um espectador entra:
socket.on('viewer-joined', async ({ viewerId, username }) => {
  console.log(`[Host] Espectador entrou: ${username} (${viewerId})`);
  addViewerToUI(viewerId, username);
  showToast(`${username} entrou na transmissão!`, 'info');

  if (currentStream) {
    // Stream já está ativo — conectar imediatamente
    setupPeerConnection(viewerId);
  } else {
    // Stream ainda não começou — guardar para conectar quando iniciar
    pendingViewers.set(viewerId, username);
    console.log(`[Host] Viewer ${viewerId} adicionado como pendente (stream ainda não iniciado)`);
  }
});

// Quando um espectador sai:
socket.on('viewer-left', ({ viewerId }) => {
  console.log(`[Host] Espectador saiu: ${viewerId}`);
  removeViewerFromUI(viewerId);
  if (peerConnections.has(viewerId)) {
    peerConnections.get(viewerId).close();
    peerConnections.delete(viewerId);
  }
});

// Configurar RTCPeerConnection para um espectador específico
async function setupPeerConnection(viewerId) {
  try {
    // Encerrar conexão anterior se existir
    if (peerConnections.has(viewerId)) {
      peerConnections.get(viewerId).close();
      peerConnections.delete(viewerId);
    }

    // Limpar fila de ICE para esta conexão
    iceCandidateQueues.set(viewerId, []);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConnections.set(viewerId, pc);

    // Adiciona todas as faixas do stream atual
    if (currentStream) {
      currentStream.getTracks().forEach(track => {
        console.log(`[Host] Adicionando track: ${track.kind} para ${viewerId}`);
        pc.addTrack(track, currentStream);
      });
    }

    // Enviar ICE candidates gerados para o espectador
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-ice-candidate', {
          targetId: viewerId,
          candidate: event.candidate
        });
      }
    };

    // Monitorar estado da conexão ICE para debug
    pc.oniceconnectionstatechange = () => {
      console.log(`[Host] ICE state (${viewerId}): ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        console.warn(`[Host] Conexão ICE falhou para ${viewerId}, tentando restart...`);
        pc.restartIce();
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Host] Connection state (${viewerId}): ${pc.connectionState}`);
    };

    // Criar oferta e enviar
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('webrtc-offer', {
      targetId: viewerId,
      sdp: pc.localDescription
    });

    console.log(`[Host] Oferta WebRTC enviada para ${viewerId}`);

  } catch (err) {
    console.error(`Erro ao configurar conexão WebRTC com espectador ${viewerId}:`, err);
  }
}

// Resposta (Answer) recebida de um espectador
socket.on('webrtc-answer', async ({ senderId, sdp }) => {
  const pc = peerConnections.get(senderId);
  if (pc) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      console.log(`[Host] Remote description definida para ${senderId}`);

      // Agora que temos remote description, despejar ICE candidates enfileirados
      const queued = iceCandidateQueues.get(senderId) || [];
      for (const candidate of queued) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('[Host] Erro ao adicionar ICE candidate da fila:', e);
        }
      }
      iceCandidateQueues.set(senderId, []);
      console.log(`[Host] ${queued.length} ICE candidate(s) da fila processados para ${senderId}`);
    } catch (err) {
      console.error('Erro ao definir remote description no host:', err);
    }
  }
});

// ICE Candidate recebido de um espectador
socket.on('webrtc-ice-candidate', async ({ senderId, candidate }) => {
  const pc = peerConnections.get(senderId);
  if (!pc || !candidate) return;

  // Se ainda não tem remote description, enfileirar
  if (!pc.remoteDescription || !pc.remoteDescription.type) {
    const queue = iceCandidateQueues.get(senderId) || [];
    queue.push(candidate);
    iceCandidateQueues.set(senderId, queue);
    console.log(`[Host] ICE candidate enfileirado para ${senderId} (sem remote desc ainda)`);
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Erro ao adicionar ICE Candidate no host:', err);
  }
});

// Lista de espectadores atualizada pelo servidor
socket.on('current-viewers', (viewers) => {
  viewersListContainer.innerHTML = '';
  viewers.forEach(v => addViewerToUI(v.id, v.username));
});

socket.on('viewer-count', (count) => {
  if (viewerCountEl) viewerCountEl.textContent = count;
});

function addViewerToUI(id, username) {
  let existing = document.getElementById(`viewer-${id}`);
  if (existing) return;

  const item = document.createElement('div');
  item.id = `viewer-${id}`;
  item.className = 'viewer-item';
  item.innerHTML = `
    <span style="display: flex; align-items: center; gap: 8px;">
      <span class="viewer-status-dot"></span>
      <strong>${username}</strong>
    </span>
    <small style="color: var(--text-muted);">WebRTC P2P</small>
  `;
  viewersListContainer.appendChild(item);
}

function removeViewerFromUI(id) {
  const item = document.getElementById(`viewer-${id}`);
  if (item) item.remove();
}

// 6. Chat ao Vivo & Reações no Host
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  socket.emit('chat-message', {
    text,
    username: 'Transmissor (Host)'
  });
  chatInput.value = '';
});

socket.on('chat-message', (msg) => {
  appendChatMessage(msg);
});

function appendChatMessage(msg) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${msg.isHost ? 'host-bubble' : ''}`;
  bubble.innerHTML = `
    <div class="bubble-meta">
      <span class="bubble-sender ${msg.isHost ? 'host-sender' : ''}">
        ${msg.sender}
        ${msg.isHost ? '<span class="badge-host-tag">HOST</span>' : ''}
      </span>
      <span class="bubble-time">${msg.timestamp}</span>
    </div>
    <div class="bubble-text">${escapeHTML(msg.text)}</div>
  `;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Reações recebidas
socket.on('new-reaction', ({ emoji }) => {
  spawnFloatingEmoji(emoji, floatingContainer);
});

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}
