#!/usr/bin/env bash
# ============================================================
# WatchPT — Reinício Rápido via SSH (sem fechar o start.js)
# Uso: ./restart.sh ou bash restart.sh
# ============================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "============================================================"
echo "  🔄 WatchPT — Solicitando Reinicialização via SSH"
echo "============================================================"

# Se o Node.js estiver acessível, usa restart.js
if command -v node >/dev/null 2>&1; then
  node restart.js
  exit $?
fi

# Fallback direto via shell caso node não esteja no PATH atual
PID_FILE="$DIR/data/server.pid"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" | tr -d '[:space:]')
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "🎯 Encerrando processo do servidor (PID: $PID)..."
    kill "$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null
    echo "✅ Servidor finalizado! O gerenciador (start.js) irá reiniciá-lo em ~3 segundos."
    exit 0
  fi
fi

echo "🎯 Tentando pkill em node server.js..."
if pkill -f "node.*server\.js" 2>/dev/null; then
  echo "✅ Servidor finalizado com sucesso!"
  echo "🛡️  O gerenciador (start.js) irá reiniciá-lo em ~3 segundos."
else
  echo "⚠️  Nenhum processo server.js ativo encontrado."
fi
