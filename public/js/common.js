// Configurações WebRTC padronizadas (STUN público do Google)
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// ─── Otimizações WebRTC e Codecs ─────────────────────────────

// Configura prioridade de codecs no PeerConnection (prioriza VP8 para evitar tela preta no Linux/Windows/Android)
function configurePeerVideoCapabilities(pc) {
  try {
    if (typeof RTCRtpSender.getCapabilities === 'function') {
      const caps = RTCRtpSender.getCapabilities('video');
      if (caps && caps.codecs) {
        const vp8Codecs = caps.codecs.filter(c => c.mimeType.toLowerCase() === 'video/vp8');
        const otherCodecs = caps.codecs.filter(c => c.mimeType.toLowerCase() !== 'video/vp8');
        const preferred = [...vp8Codecs, ...otherCodecs];
        pc.getTransceivers().forEach(tr => {
          if (tr.sender && tr.sender.track && tr.sender.track.kind === 'video') {
            if (typeof tr.setCodecPreferences === 'function') {
              tr.setCodecPreferences(preferred);
            }
          }
        });
      }
    }
  } catch (e) {
    console.warn('[WebRTC] Falha ao configurar setCodecPreferences:', e);
  }
}

// Fallback robusto no SDP para garantir o codec VP8 no topo de m=video
function preferVP8InSdp(sdp) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  const lines = sdp.split('\r\n');
  const mVideoIndex = lines.findIndex(l => l.startsWith('m=video '));
  if (mVideoIndex === -1) return sdp;

  let vp8Payload = null;
  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+VP8\/90000/i);
    if (match) {
      vp8Payload = match[1];
      break;
    }
  }

  if (!vp8Payload) return sdp;

  const mParts = lines[mVideoIndex].split(' ');
  const header = mParts.slice(0, 3);
  const payloads = mParts.slice(3).filter(p => p !== vp8Payload);
  lines[mVideoIndex] = [...header, vp8Payload, ...payloads].join(' ');

  return lines.join('\r\n');
}

// Otimização de parâmetros do sender (controle de bitrate e degradação suave de framerate)
function optimizeVideoSender(sender) {
  if (!sender || !sender.track || sender.track.kind !== 'video') return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = 2500000; // 2.5 Mbps máximo por espectador
    params.degradationPreference = 'maintain-framerate'; // Prioriza fluidez e estabilidade de FPS
    sender.setParameters(params).catch(e => console.warn('[WebRTC] setParameters aviso:', e.message));
  } catch (e) {
    console.warn('[WebRTC] optimizeVideoSender erro:', e);
  }
}

// Gerenciador de Toasts (Notificações)
function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '⚠️';
  if (type === 'live') icon = '🔴';

  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Criar animação de reação flutuante
function spawnFloatingEmoji(emoji, container) {
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;

  // Posição horizontal aleatória (20% a 80%)
  const randomX = Math.floor(Math.random() * 60) + 20;
  el.style.left = `${randomX}%`;

  container.appendChild(el);

  setTimeout(() => {
    el.remove();
  }, 2400);
}

// Helpers de Nome de Usuário
function getSavedUsername() {
  let name = localStorage.getItem('stream_username');
  if (!name) {
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    name = `Amigo #${randomNum}`;
    localStorage.setItem('stream_username', name);
  }
  return name;
}

function saveUsername(name) {
  if (name && name.trim()) {
    localStorage.setItem('stream_username', name.trim());
  }
}
