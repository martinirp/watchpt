const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configurações do Manager (iguais ao invoker-bot)
const RESTART_DELAY = 3000;    // Delay antes de reiniciar (3 segundos)
const MAX_RESTARTS = 10;       // Máximo de restarts consecutivos
const RESTART_WINDOW = 60000;  // Janela de tempo para contar restarts (1 minuto)

const DATA_DIR = path.join(__dirname, 'data');
const PID_FILE = path.join(DATA_DIR, 'server.pid');

function saveServerPid(pid) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(pid), 'utf8');
  } catch (e) {
    console.warn('⚠️  [MANAGER] Não foi possível salvar data/server.pid:', e.message);
  }
}

function removeServerPid() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch (e) {}
}

let restartCount = 0;
let lastRestartTime = 0;
let serverProcess = null;
let uptimeTimer = null;

function shouldRestart() {
  const now = Date.now();

  // Reseta contagem se fora da janela
  if (now - lastRestartTime > RESTART_WINDOW) {
    restartCount = 0;
  }

  if (restartCount >= MAX_RESTARTS) {
    console.error(`🛑 [MANAGER] Máximo de ${MAX_RESTARTS} restarts atingido em ${RESTART_WINDOW}ms. Abortando.`);
    return false;
  }

  restartCount++;
  lastRestartTime = now;
  return true;
}

function startServer() {
  const serverScript = path.join(__dirname, 'server.js');

  console.log(`\n🚀 [MANAGER] Iniciando StreamHub (tentativa ${restartCount})...`);

  // Executa o servidor filho mantendo stdout/stderr intactos
  serverProcess = spawn(process.execPath, [serverScript], {
    stdio: 'inherit',
    cwd: __dirname,
    env: process.env
  });

  if (serverProcess && serverProcess.pid) {
    saveServerPid(serverProcess.pid);
    console.log(`📌 [MANAGER] StreamHub rodando sob PID: ${serverProcess.pid}`);
  }

  // Se o servidor ficar estável por 10s, zera contador de restarts (para reinícios manuais não acumularem)
  if (uptimeTimer) clearTimeout(uptimeTimer);
  uptimeTimer = setTimeout(() => {
    if (serverProcess) {
      restartCount = 0;
    }
  }, 10000);

  serverProcess.on('exit', (code, signal) => {
    console.log(`\n⚠️  [MANAGER] StreamHub encerrou (code: ${code}, signal: ${signal})`);
    removeServerPid();
    serverProcess = null;

    if (shouldRestart()) {
      console.log(`⏳ [MANAGER] Reiniciando em ${RESTART_DELAY}ms...`);
      setTimeout(startServer, RESTART_DELAY);
    } else {
      console.error(`🛑 [MANAGER] StreamHub não será reiniciado.`);
      process.exit(1);
    }
  });

  serverProcess.on('error', (err) => {
    console.error(`❌ [MANAGER] Erro ao iniciar StreamHub:`, err);
  });
}

// Encerramento gracioso de sinais do SO
process.on('SIGTERM', () => {
  console.log('\n🛑 [MANAGER] SIGTERM recebido, encerrando...');
  removeServerPid();
  if (serverProcess) serverProcess.kill('SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 [MANAGER] SIGINT (Ctrl+C) recebido, encerrando...');
  removeServerPid();
  if (serverProcess) serverProcess.kill('SIGINT');
  process.exit(0);
});

console.log('🛡️  [MANAGER] Gerenciador de Processo iniciado. Monitorando restarts...\n');

startServer();
