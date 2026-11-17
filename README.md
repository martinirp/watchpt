# StreamHub / WatchPT

Transmissão de tela, arquivo de vídeo ou câmera com chat e reações.

## Arquitetura (v2 — SFU LiveKit)

- O streamer envia o vídeo **uma única vez** para o servidor de mídia **LiveKit** (`livekit/livekit-server.exe`, iniciado automaticamente pelo `server.js`).
- O LiveKit distribui para todos os espectadores com **simulcast** (cada um recebe a melhor qualidade que a sua rede aguenta), controle de congestionamento e **reconexão automática**.
- Login, lobby, chat e reações continuam via Socket.io.
- A sinalização do LiveKit passa pelo próprio servidor em `wss://<host>:7070/lk` (mesmo certificado do site).

## Iniciar

```
start.bat      (ou: node start.js)
```

## Amigos pela internet — liberar no roteador (port forwarding → IP do seu PC)

| Porta | Protocolo | Uso |
|-------|-----------|-----|
| 7070  | TCP | Site + sinalização |
| 7882  | UDP | Vídeo/áudio (principal) |
| 7881  | TCP | Vídeo/áudio (fallback se UDP falhar) |

Libere também no Firewall do Windows (`livekit-server.exe` e `node.exe`).

## Qualidade

No Estúdio escolha 1080p60 / 1080p30 / 720p60 / 720p30 e o codec (VP8 compatível ou H.264 usando GPU).
Dica: se o PC engasgar ao transmitir jogos, use **H.264** e/ou 1080p30.

## Reinstalar o LiveKit

Baixe `livekit_*_windows_amd64.zip` em https://github.com/livekit/livekit/releases e extraia o `livekit-server.exe` em `livekit/`.
