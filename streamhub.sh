#!/usr/bin/env bash
# ============================================================
# StreamHub Linux Service Runner (Loop com Auto-Restart)
# Não precisa de PM2 nem dependências externas
# ============================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "============================================================"
echo "  🚀 StreamHub — Supervisor de Processo"
echo "  Diretório: $DIR"
echo "  Porta: ${PORT:-7070}"
echo "============================================================"
echo ""

node start.js
