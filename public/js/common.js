// Configurações WebRTC padronizadas (STUN público do Google)
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

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
