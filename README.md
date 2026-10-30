# 🚀 StreamHub - Reprodutor de Vídeo e Transmissão Local

Um servidor de transmissão de vídeo e tela com **latência ultra-baixa (quase zero segundos)** usando **WebRTC P2P** e **Socket.io**, hospedado diretamente no seu computador!

---

## 🌟 Funcionalidades

1. **Transmissão Direta do seu Navegador**:
   - 🖥️ **Compartilhar Tela ou Janela**: Transmita jogos, abas do Chrome com som ou telas inteiras.
   - 🎬 **Transmitir Arquivo de Vídeo**: Selecione vídeos MP4, MKV ou WebM do seu computador para assistir junto com os amigos com controle sincronizado de play/pause.
   - 📹 **Câmera & Microfone**: Transmissão ao vivo com webcam.
2. **Player Cinematográfico para os Amigos**:
   - Visual Dark Mode moderno com glassmorphism.
   - Controles customizados de volume, tela cheia e Picture-in-Picture (PiP).
   - Detecção automática de status (Ao Vivo / Aguardando).
3. **Interatividade em Tempo Real**:
   - Chat ao vivo com identificação do Host.
   - Reações rápidas flutuantes com emojis na tela (🔥, ❤️, 👏, 😂, 🚀, 🍿).
   - Contador de espectadores online e monitoramento de conexão WebRTC.
4. **Detecção Automática do seu Endereço IP**:
   - O servidor identifica automaticamente o seu IP local e gera o link pronto com botão de copiar em 1 clique.

---

## 🛠️ Como Iniciar

### 1. Iniciar o Servidor
Você pode dar dois cliques no arquivo `start.bat` ou executar no terminal dentro da pasta do projeto:
```bash
node server.js
```

O terminal exibirá os links de acesso:
```text
======================================================
   🚀 STREAM HUB - SERVIDOR DE VÍDEO PRONTO!
======================================================
📍 Painel do Host (você transmite aqui):
   👉 http://localhost:7070/host

🔗 Link para seus amigos assistirem:
   👉 http://192.168.3.20:7070
======================================================
```

---

## 👥 Como Transmitir e Convidar Amigos

### Passo 1: Abrir o Painel do Host
Abra no seu navegador:
👉 [http://localhost:7070/host](http://localhost:7070/host)

### Passo 2: Escolher o que transmitir
- Escolha **"Tela ou Janela"**, **"Arquivo de Vídeo"** ou **"Câmera & Mic"**.
- Clique em **"Iniciar Transmissão"**.
- Se for tela/aba, lembre-se de marcar a caixinha **"Compartilhar áudio"** na janela de permissão do navegador para que seus amigos também ouçam o som!

### Passo 3: Passar o link para os amigos

#### Se os amigos estiverem na mesma rede (mesmo Wi-Fi ou Cabo da sua casa):
Basta enviar o link que aparece no topo do painel:
👉 `http://192.168.3.20:7070` *(ou o IP exibido no seu painel)*

#### Se os amigos estiverem na casa deles (pela Internet):
Para amigos fora da sua casa assistirem, você tem 2 formas muito simples:

1. **Método 1 (Super Rápido com Túnel Gratuito - Sem mexer no modem)**:
   Abra um novo terminal e execute:
   ```bash
   npx localtunnel --port 7070
   ```
   Ele gerará um link público seguro (ex: `https://lucas-stream.loca.lt`) que você pode mandar para qualquer pessoa no mundo!

2. **Método 2 (Redirecionamento de Porta / Port Forwarding)**:
   - Acesse as configurações do seu roteador Wi-Fi.
   - Crie uma regra de Port Forwarding redirecionando a porta externa `7070` (TCP/UDP) para o IP interno do seu PC (`192.168.3.20`).
   - Seus amigos acessarão pelo seu IP público: `http://SEU-IP-PUBLICO:7070`.
