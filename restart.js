#!/usr/bin/env node
// ============================================================
// WatchPT — Forçar reinício do servidor (sem derrubar o manager)
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PID_FILE = path.join(__dirname, 'data', 'server.pid');

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (e) {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch (err) {
      return false;
    }
  }
}

console.log('🔄 [WatchPT] Forçando encerramento do servidor para reinicialização...');

let targetPid = null;

// 1. Tentar ler do arquivo data/server.pid
if (fs.existsSync(PID_FILE)) {
  try {
    const content = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(content, 10);
    if (!isNaN(pid) && isRunning(pid)) {
      targetPid = pid;
    }
  } catch (e) {}
}

// 2. Se não encontrou pelo PID file, busca por processo ativo
if (!targetPid) {
  try {
    if (process.platform === 'win32') {
      const out = execSync('wmic process where "name=\'node.exe\' and commandline like \'%server.js%\'" get processid', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const matches = out.match(/\d+/g);
      if (matches && matches.length > 0) {
        targetPid = parseInt(matches[0], 10);
      }
    } else {
      const out = execSync('pgrep -f "node.*server\\.js"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const pids = out.split('\n').map(p => parseInt(p, 10)).filter(p => !isNaN(p) && p !== process.pid);
      if (pids.length > 0) {
        targetPid = pids[0];
      }
    }
  } catch (e) {}
}

if (targetPid && isRunning(targetPid)) {
  console.log(`🎯 Encontrado processo do servidor (PID: ${targetPid}). Enviando sinal de término...`);
  killPid(targetPid);

  // Aguarda até 3 segundos para confirmar finalização
  let attempts = 0;
  while (isRunning(targetPid) && attempts < 6) {
    execSync(process.platform === 'win32' ? 'ping 127.0.0.1 -n 2 > nul' : 'sleep 0.5');
    attempts++;
  }

  if (isRunning(targetPid)) {
    console.warn('⚠️ Processo ainda ativo, forçando SIGKILL...');
    try { process.kill(targetPid, 'SIGKILL'); } catch (e) {}
  }

  console.log('✅ Servidor finalizado com sucesso!');
  console.log('🛡️  O gerenciador (start.js) detectará a saída e subirá a versão atualizada em ~3 segundos.');
  process.exit(0);
} else {
  console.log('⚠️  Nenhum processo ativo de "server.js" foi localizado.');
  console.log('💡 Certifique-se de que o gerenciador "node start.js" está em execução.');
  process.exit(0);
}
