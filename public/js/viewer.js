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

// Estado do Espectador
let peerConnection = null;
let iceCandidateQueue = []; // Buffer de ICE candidates antes de setRemoteDescription
let currentUsername = getSavedUsername();

// Elementos DOM
const remoteVideo = document.getElementById('remoteVideo');
const streamPlaceholder = document.getElementById('streamPlaceholder');
const placeholderTitle = document.getElementById('placeholderTitle');
const placeholderDesc = document.getElementById('placeholderDesc');
const streamTitleEl = document.getElementById('streamTitle');
const liveBadge = document.getElementById('liveBadge');
const viewerCountEl = document.getElementById('viewerCount');
const floatingContainer = document.getElementById('floatingReactions');

// Controles de Vídeo
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
const usernameInput = document.getElementById('usernameInput');
const reactionButtons = document.querySelectorAll('.reaction-btn');

// Inicialização do Nome de Usuário
if (usernameInput) {
  usernameInput.value = currentUsername;
  usernameInput.addEventListener('change', () => {
    currentUsername = usernameInput.value.trim() || 'Espectador';
    saveUsername(currentUsername);
    showToast(`Seu nome de exibição agora é "${currentUsername}"`, 'info');
  });
}

// 1. Entrar na sala de transmissão
socket.emit('join-as-viewer', { username: currentUsername });

socket.on('connect', () => {
  console.log('[Viewer] Conectado ao servidor');
});

// 2. Status do Stream
socket.on('stream-status', (status) => {
  console.log('[Viewer] Status do Stream recebido:', status);
  if (streamTitleEl && status.title) {
    streamTitleEl.textContent = status.title;
  }

  if (status.isLive) {
    liveBadge.classList.remove('offline');
    liveBadge.innerHTML = `<span class="pulse-dot"></span> AO VIVO`;
    streamPlaceholder.classList.add('hidden');
  } else {
    liveBadge.classList.add('offline');
    liveBadge.innerHTML = `<span class="pulse-dot"></span> OFFLINE`;
    streamPlaceholder.classList.remove('hidden');

    if (!status.hostAvailable) {
      placeholderTitle.textContent = 'Transmissor Desconectado';
      placeholderDesc.textContent = 'O transmissor não está conectado no momento. Aguarde ele entrar...';
    } else {
      placeholderTitle.textContent = 'Aguardando Início';
      placeholderDesc.textContent = 'O transmissor está online e se preparando para transmitir...';
    }

    if (remoteVideo.srcObject) {
      remoteVideo.srcObject = null;
    }
  }
});

socket.on('viewer-count', (count) => {
  if (viewerCountEl) viewerCountEl.textContent = count;
});

// 3. WebRTC: Receber Oferta do Host
socket.on('webrtc-offer', async ({ senderId, sdp }) => {
  console.log('[Viewer] Recebeu oferta WebRTC do Host, recriando peerConnection...');

  try {
    // Fechar conexão anterior e limpar fila de ICE
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    iceCandidateQueue = [];

    peerConnection = new RTCPeerConnection(RTC_CONFIG);

    // Quando o stream do host chegar
    peerConnection.ontrack = (event) => {
      console.log('[Viewer] Track recebida:', event.track.kind, '| streams:', event.streams.length);
      if (event.streams && event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        streamPlaceholder.classList.add('hidden');
        liveBadge.classList.remove('offline');
        liveBadge.innerHTML = `<span class="pulse-dot"></span> AO VIVO`;

        // Tentar reproduzir (pode ser bloqueado por autoplay policy)
        const playPromise = remoteVideo.play();
        if (playPromise !== undefined) {
          playPromise.catch((error) => {
            console.warn('[Viewer] Autoplay bloqueado, mostrando botão de ativar áudio');
            if (unmuteBanner) unmuteBanner.style.display = 'flex';
          });
        }
      }
    };

    // ICE candidates para o host
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-ice-candidate', {
          targetId: senderId,
          candidate: event.candidate
        });
      }
    };

    // Monitorar estado da conexão
    peerConnection.oniceconnectionstatechange = () => {
      console.log('[Viewer] ICE state:', peerConnection.iceConnectionState);
    };

    peerConnection.onconnectionstatechange = () => {
      console.log('[Viewer] Connection state:', peerConnection.connectionState);
    };

    // Definir oferta remota
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    console.log('[Viewer] Remote description definida. Descarregando fila de ICE:', iceCandidateQueue.length, 'item(s)');

    // Descarregar a fila de ICE candidates que chegaram antes da remote description
    for (const candidate of iceCandidateQueue) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[Viewer] Erro ao adicionar ICE candidate da fila:', e);
      }
    }
    iceCandidateQueue = [];

    // Criar resposta e enviar ao host
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('webrtc-answer', {
      targetId: senderId,
      sdp: peerConnection.localDescription
    });

    console.log('[Viewer] Answer enviado ao host.');

  } catch (err) {
    console.error('[Viewer] Erro ao processar oferta WebRTC:', err);
  }
});

// Candidato ICE do Host
socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (!candidate) return;

  // Se ainda não tem remote description, enfileirar
  if (!peerConnection || !peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
    console.log('[Viewer] ICE candidate enfileirado (remote description ainda não definida)');
    iceCandidateQueue.push(candidate);
    return;
  }

  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('[Viewer] Erro ao adicionar ICE candidate:', err);
  }
});

// 4. Banner de Desmutar (caso política de autoplay silencie)
if (unmuteBanner) {
  unmuteBanner.addEventListener('click', () => {
    remoteVideo.muted = false;
    remoteVideo.play();
    unmuteBanner.style.display = 'none';
    if (volumeSlider) volumeSlider.value = remoteVideo.volume || 1;
    showToast('Áudio ativado!', 'success');
  });
}

// 5. Controles Customizados do Vídeo
if (btnPlayPause) {
  btnPlayPause.addEventListener('click', () => {
    if (remoteVideo.paused) {
      remoteVideo.play();
      btnPlayPause.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
    } else {
      remoteVideo.pause();
      btnPlayPause.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
    }
  });
}

if (btnMute) {
  btnMute.addEventListener('click', () => {
    remoteVideo.muted = !remoteVideo.muted;
    updateMuteIcon();
  });
}

if (volumeSlider) {
  volumeSlider.addEventListener('input', (e) => {
    remoteVideo.volume = parseFloat(e.target.value);
    remoteVideo.muted = remoteVideo.volume === 0;
    updateMuteIcon();
  });
}

function updateMuteIcon() {
  if (remoteVideo.muted || remoteVideo.volume === 0) {
    btnMute.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
  } else {
    btnMute.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
  }
}

if (btnFullscreen) {
  btnFullscreen.addEventListener('click', () => {
    const theater = document.querySelector('.video-theater');
    if (!document.fullscreenElement) {
      theater.requestFullscreen().catch(err => {
        showToast('Não foi possível entrar em tela cheia: ' + err.message, 'error');
      });
    } else {
      document.exitFullscreen();
    }
  });
}

if (btnPip) {
  btnPip.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled && remoteVideo.readyState >= 2) {
        await remoteVideo.requestPictureInPicture();
      }
    } catch (err) {
      showToast('Picture-in-Picture não suportado neste navegador.', 'error');
    }
  });
}

// 6. Chat ao Vivo
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  socket.emit('chat-message', {
    text,
    username: currentUsername
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
        ${escapeHTML(msg.sender)}
        ${msg.isHost ? '<span class="badge-host-tag">HOST</span>' : ''}
      </span>
      <span class="bubble-time">${msg.timestamp}</span>
    </div>
    <div class="bubble-text">${escapeHTML(msg.text)}</div>
  `;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// 7. Reações Rápidas
reactionButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const emoji = btn.getAttribute('data-emoji') || '🔥';
    socket.emit('send-reaction', {
      emoji,
      sender: currentUsername
    });
    spawnFloatingEmoji(emoji, floatingContainer);
  });
});

socket.on('new-reaction', ({ emoji }) => {
  spawnFloatingEmoji(emoji, floatingContainer);
});

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}
