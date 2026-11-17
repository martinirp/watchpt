// ============================================================
// StreamHub — Camada de mídia (WebRTC P2P Direto)
// O vídeo e áudio vão direto do transmissor para cada espectador,
// usando apenas o Socket.io do servidor para sinalização (SDP/ICE).
// ============================================================
(function () {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  async function getIceServers() {
    try {
      const res = await fetch('/api/ice-servers');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.iceServers) && data.iceServers.length) {
          return data.iceServers;
        }
      }
    } catch (e) {}
    return ICE_SERVERS;
  }

  const ConnectionQuality = {
    Excellent: 'excellent',
    Good: 'good',
    Poor: 'poor',
    Lost: 'lost',
    Unknown: 'unknown'
  };

  // ─── Presets de qualidade do streamer ──────────────────────
  const QUALITY_PRESETS = {
    '1080p60': { label: '1080p 60fps (8 Mbps)', width: 1920, height: 1080, fps: 60, bitrate: 8000000 },
    '1080p30': { label: '1080p 30fps (5 Mbps)', width: 1920, height: 1080, fps: 30, bitrate: 5000000 },
    '720p60':  { label: '720p 60fps (4 Mbps)',  width: 1280, height: 720,  fps: 60, bitrate: 4000000 },
    '720p30':  { label: '720p 30fps (2.5 Mbps)', width: 1280, height: 720, fps: 30, bitrate: 2500000 }
  };

  function videoConstraints(presetKey) {
    const p = QUALITY_PRESETS[presetKey] || QUALITY_PRESETS['1080p60'];
    return {
      width: { ideal: p.width },
      height: { ideal: p.height },
      frameRate: { ideal: p.fps, max: p.fps }
    };
  }

  function getSocket() {
    return window.__shSocket || null;
  }

  function preferVideoCodec(pc, codecName) {
    try {
      if (!codecName || typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
      const caps = RTCRtpSender.getCapabilities('video');
      if (!caps || !caps.codecs) return;
      const wanted = codecName.toLowerCase();
      const preferred = caps.codecs.filter(c => c.mimeType.toLowerCase().includes(wanted));
      const others = caps.codecs.filter(c => !c.mimeType.toLowerCase().includes(wanted));
      if (!preferred.length) return;
      for (const t of pc.getTransceivers()) {
        if (t.sender && t.sender.track && t.sender.track.kind === 'video' && t.setCodecPreferences) {
          t.setCodecPreferences([...preferred, ...others]);
        }
      }
    } catch (e) {}
  }

  async function applyVideoBitrate(pc, presetKey) {
    try {
      const p = QUALITY_PRESETS[presetKey] || QUALITY_PRESETS['1080p60'];
      for (const sender of pc.getSenders()) {
        if (sender.track && sender.track.kind === 'video') {
          const params = sender.getParameters();
          if (!params.encodings || !params.encodings.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = p.bitrate;
          params.encodings[0].maxFramerate = p.fps;
          await sender.setParameters(params).catch(() => {});
        }
      }
    } catch (e) {}
  }

  // ============================================================
  // PUBLISHER (quem transmite — envia P2P direto para cada viewer)
  // ============================================================
  class Publisher {
    constructor(handlers = {}) {
      this.h = handlers; // { onState(state), onQuality(q), onFatal(msg) }
      this.stream = null;
      this.opts = null;
      this.stopped = true;
      this.peers = new Map(); // viewerId -> { pc, pendingIce: [] }
      this._bound = false;

      this._onViewerJoin = ({ viewerId }) => this._createPeerForViewer(viewerId);
      this._onViewerLeft = ({ viewerId }) => this._closePeer(viewerId);
      this._onAnswer = async ({ from, sdp }) => {
        const entry = this.peers.get(from);
        if (!entry || !sdp) return;
        try {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
          for (const c of entry.pendingIce) {
            await entry.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
          entry.pendingIce = [];
        } catch (e) {
          console.warn('[P2P Publisher] Erro ao aplicar answer:', e.message);
        }
      };
      this._onIce = async ({ from, candidate }) => {
        const entry = this.peers.get(from);
        if (!entry || !candidate) return;
        if (entry.pc.remoteDescription) {
          await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        } else {
          entry.pendingIce.push(candidate);
        }
      };
    }

    async start(stream, opts) {
      this.stream = stream;
      this.opts = opts || {};
      this.stopped = false;
      this._bindSocket();
      this.h.onState && this.h.onState('connected');
      this.h.onQuality && this.h.onQuality(ConnectionQuality.Excellent);
    }

    _bindSocket() {
      const s = getSocket();
      if (!s || this._bound) return;
      this._bound = true;
      s.on('viewer-joined', this._onViewerJoin);
      s.on('rtc-ready', this._onViewerJoin);
      s.on('viewer-left', this._onViewerLeft);
      s.on('rtc-answer', this._onAnswer);
      s.on('rtc-ice', this._onIce);
    }

    _unbindSocket() {
      const s = getSocket();
      if (!s || !this._bound) return;
      this._bound = false;
      s.off('viewer-joined', this._onViewerJoin);
      s.off('rtc-ready', this._onViewerJoin);
      s.off('viewer-left', this._onViewerLeft);
      s.off('rtc-answer', this._onAnswer);
      s.off('rtc-ice', this._onIce);
    }

    async _createPeerForViewer(viewerId) {
      if (this.stopped || !this.stream || !viewerId) return;
      const prev = this.peers.get(viewerId);
      if (prev && (Date.now() - prev.createdAt) < 1500 && prev.pc.connectionState !== 'failed') {
        return; // evita recriar peer durante handshake em andamento
      }
      this._closePeer(viewerId);

      const s = getSocket();
      if (!s) return;

      const iceServers = await getIceServers();
      if (this.stopped) return;

      const pc = new RTCPeerConnection({ iceServers });
      const entry = { pc, pendingIce: [], createdAt: Date.now() };
      this.peers.set(viewerId, entry);

      for (const track of this.stream.getTracks()) {
        if (track.readyState !== 'live') continue;
        if (track.kind === 'video') {
          try { track.contentHint = 'motion'; } catch (e) {}
        }
        pc.addTrack(track, this.stream);
      }

      preferVideoCodec(pc, this.opts && this.opts.codec);

      pc.onicecandidate = (e) => {
        if (e.candidate && !this.stopped) {
          s.emit('rtc-ice', { to: viewerId, candidate: e.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          applyVideoBitrate(pc, this.opts && this.opts.preset);
          this.h.onQuality && this.h.onQuality(ConnectionQuality.Excellent);
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          this._closePeer(viewerId);
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        s.emit('rtc-offer', { to: viewerId, sdp: pc.localDescription });
      } catch (e) {
        console.warn('[P2P Publisher] Erro ao criar offer:', e.message);
        this._closePeer(viewerId);
      }
    }

    _closePeer(viewerId) {
      const entry = this.peers.get(viewerId);
      if (!entry) return;
      this.peers.delete(viewerId);
      try { entry.pc.close(); } catch (e) {}
    }

    async stop() {
      this.stopped = true;
      this._unbindSocket();
      for (const viewerId of [...this.peers.keys()]) {
        this._closePeer(viewerId);
      }
      this.stream = null;
    }
  }

  // ============================================================
  // VIEWER (quem assiste — recebe P2P direto do transmissor)
  // ============================================================
  class Viewer {
    constructor(videoEl, handlers = {}) {
      this.video = videoEl;
      this.h = handlers; // { onStatus(text, level), onPlaying(), onNeedUnmute(), onStopped() }
      this.streamId = null;
      this.pc = null;
      this.pendingIce = [];
      this.attempt = 0;
      this.watchdog = null;
      this.lastFrames = 0;
      this.lastFramesAt = 0;
      this.quality = ConnectionQuality.Unknown;
      this._bound = false;

      this._onOffer = async ({ from, sdp }) => {
        if (!this.streamId || from !== this.streamId || !sdp) return;
        await this._handleOffer(from, sdp);
      };

      this._onIce = async ({ from, candidate }) => {
        if (!this.pc || !this.streamId || from !== this.streamId || !candidate) return;
        if (this.pc.remoteDescription) {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        } else {
          this.pendingIce.push(candidate);
        }
      };
    }

    _bindSocket() {
      const s = getSocket();
      if (!s || this._bound) return;
      this._bound = true;
      s.on('rtc-offer', this._onOffer);
      s.on('rtc-ice', this._onIce);
    }

    _unbindSocket() {
      const s = getSocket();
      if (!s || !this._bound) return;
      this._bound = false;
      s.off('rtc-offer', this._onOffer);
      s.off('rtc-ice', this._onIce);
    }

    async connect(streamId) {
      this.disconnect(true);
      this.streamId = streamId;
      const attempt = ++this.attempt;
      this._bindSocket();
      this.h.onStatus && this.h.onStatus('Conectando P2P ao transmissor...', 'info');
      this._startWatchdog(attempt);

      // Pede um offer caso o viewer-joined já tenha sido processado antes
      const s = getSocket();
      if (s && s.connected) {
        setTimeout(() => {
          if (attempt === this.attempt && !this.pc && this.streamId) {
            s.emit('rtc-ready', { to: this.streamId });
          }
        }, 2500);
      }
    }

    async _handleOffer(streamerId, sdp) {
      const attempt = this.attempt;
      if (this.pc) { try { this.pc.close(); } catch (e) {} this.pc = null; }
      this.pendingIce = [];

      const s = getSocket();
      const iceServers = await getIceServers();
      if (attempt !== this.attempt) return;
      const pc = new RTCPeerConnection({ iceServers });
      this.pc = pc;
      const remoteStream = new MediaStream();

      pc.ontrack = (e) => {
        if (attempt !== this.attempt) return;
        if (e.streams && e.streams[0]) {
          this.video.srcObject = e.streams[0];
        } else {
          remoteStream.addTrack(e.track);
          this.video.srcObject = remoteStream;
        }
        this.lastFrames = 0;
        this.lastFramesAt = Date.now();
        this._tryPlay();
      };

      pc.onicecandidate = (e) => {
        if (e.candidate && s && attempt === this.attempt) {
          s.emit('rtc-ice', { to: streamerId, candidate: e.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        if (attempt !== this.attempt) return;
        const st = pc.connectionState;
        if (st === 'connected') {
          this.quality = ConnectionQuality.Good;
          this.h.onStatus && this.h.onStatus('Conectado (P2P Direto)', 'ok');
          if (this.video.videoWidth > 0 && this.h.onPlaying) this.h.onPlaying();
        } else if (st === 'disconnected') {
          this.quality = ConnectionQuality.Poor;
          this.h.onStatus && this.h.onStatus('Reconectando P2P...', 'info');
        } else if (st === 'failed') {
          this.quality = ConnectionQuality.Lost;
          this.h.onStatus && this.h.onStatus('Conexão P2P falhou. Tentando novamente...', 'info');
          setTimeout(() => {
            if (attempt === this.attempt && this.streamId && s && s.connected) {
              s.emit('rtc-ready', { to: this.streamId });
            }
          }, 1500);
        }
      };

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        for (const c of this.pendingIce) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        this.pendingIce = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (s) s.emit('rtc-answer', { to: streamerId, sdp: pc.localDescription });
      } catch (e) {
        console.warn('[P2P Viewer] Erro ao responder offer:', e.message);
      }
    }

    _tryPlay() {
      const v = this.video;
      v.muted = false;
      const p = v.play();
      if (p && p.catch) {
        p.catch(() => {
          v.muted = true;
          v.play().catch(() => {});
          this.h.onNeedUnmute && this.h.onNeedUnmute();
        });
      }
    }

    _startWatchdog(attempt) {
      clearInterval(this.watchdog);
      this.watchdog = setInterval(async () => {
        if (attempt !== this.attempt || !this.pc) return;
        try {
          const stats = await this.pc.getStats();
          let frames = 0;
          stats.forEach(r => {
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
              frames = r.framesDecoded || 0;
            }
          });
          const now = Date.now();
          if (frames !== this.lastFrames) {
            this.lastFrames = frames;
            this.lastFramesAt = now;
            if (this.video.videoWidth > 0 && this.h.onPlaying) this.h.onPlaying();
            if (this.video.paused && this.video.readyState >= 2) this._tryPlay();
          }
        } catch (e) {}
      }, 2000);
    }

    async getStats() {
      const out = {
        state: this.pc ? this.pc.connectionState : 'disconnected',
        quality: this.quality
      };
      if (this.pc) {
        try {
          const stats = await this.pc.getStats();
          stats.forEach(r => {
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
              out.framesDecoded = r.framesDecoded;
              out.framesDropped = r.framesDropped;
              out.bytesReceived = r.bytesReceived;
              out.frameWidth = r.frameWidth;
              out.frameHeight = r.frameHeight;
              out.framesPerSecond = r.framesPerSecond;
            }
          });
        } catch (e) {}
      }
      return out;
    }

    disconnect(silent) {
      this.attempt++;
      clearInterval(this.watchdog);
      this.watchdog = null;
      this._unbindSocket();
      this.pendingIce = [];
      if (this.pc) {
        try { this.pc.close(); } catch (e) {}
        this.pc = null;
      }
      try { this.video.pause(); } catch (e) {}
      this.video.srcObject = null;
      this.video.removeAttribute('src');
      if (!silent) {
        this.streamId = null;
        this.h.onStopped && this.h.onStopped();
      }
    }
  }

  window.StreamMedia = { Publisher, Viewer, QUALITY_PRESETS, videoConstraints, ConnectionQuality };
})();
