# Especificaciones Técnicas — eQSO ASORAPA Linux

**Versión:** 1.0  
**Última actualización:** Abril 2026  
**Repositorio:** `daycart/eqso-linux-client`

---

## 1. Visión general

Puerto completo del sistema eQSO VoIP de radioenlace a Linux, compatible con el cliente Windows eQSO v1.13. Permite a estaciones CB27 comunicarse por internet a través de salas de voz compartidas. El sistema consta de dos artefactos:

| Artefacto | Descripción |
|---|---|
| `api-server` | Servidor TCP eQSO + API REST + bridge WebSocket |
| `eqso-client` | Cliente web React (eQSO ASORAPA) |

---

## 2. Arquitectura general

```
Cliente Windows eQSO v1.13
        │ TCP :2171 / :8008
        ▼
┌──────────────────────────────────────────────────────┐
│                   api-server (Node.js)                │
│                                                       │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────┐  │
│  │  TCP Server │   │  WS Bridge   │   │ REST API  │  │
│  │ :2171/:8008 │   │   /ws        │   │  /api/*   │  │
│  └──────┬──────┘   └──────┬───────┘   └─────┬─────┘  │
│         │                 │                 │         │
│         └─────────────────┼─────────────────┘         │
│                           │                           │
│                    ┌──────▼──────┐                    │
│                    │ RoomManager │                    │
│                    │  (en RAM)   │                    │
│                    └─────────────┘                    │
│                                                       │
│  ┌──────────────────────────────────────────────────┐  │
│  │              EqsoProxy (saliente)                │  │
│  │  Browser WS → GSM encode → TCP eQSO externo     │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
        │ WebSocket /ws
        ▼
Cliente web React (eqso-client)
  (HTTPS en asorapa.sytes.net)
```

---

## 3. Servidor — `api-server`

### 3.1 Tecnologías

| Componente | Tecnología |
|---|---|
| Runtime | Node.js 20, TypeScript |
| Framework HTTP | Express 4 |
| WebSocket | `ws` library |
| TCP | Módulo `net` nativo Node.js |
| ORM / DB | Drizzle ORM + PostgreSQL |
| Logs | Pino (JSON estructurado, nivel 30=info) |
| Codec audio | FFmpeg GSM 06.10 (proceso hijo, streaming) |

### 3.2 Puertos

| Puerto | Protocolo | Uso |
|---|---|---|
| `$PORT` (8080) | HTTP + WS | API REST y WebSocket bridge |
| 2171 | TCP | Protocolo eQSO estándar |
| 8008 | TCP | Puerto alternativo ASORAPA-compatible |

### 3.3 Protocolo TCP eQSO (binario)

Protocolo binario propietario de Windows eQSO, obtenido por ingeniería inversa.

#### 3.3.1 Opcodes

| Byte | Nombre | Dirección | Descripción |
|---|---|---|---|
| `0x01` | VOICE | C→S, S→C | Trama de audio GSM (198 bytes de payload) |
| `0x02` | IGNORE/SILENCE | C→S | Heartbeat de silencio del cliente (cada ~150ms) |
| `0x06` | PTT_RELEASE_2 | S→C | `[0x06][nameLen][name]` — señal adicional de fin PTT |
| `0x08` | PTT_RELEASE_1 | S→C | 1 byte — señal de fin PTT |
| `0x0a` | HANDSHAKE | C→S, S→C | 5 bytes. Cliente: `[0x0a][var][0x00 0x00 0x00]`. Servidor: `[0x0a 0xfa 0x00 0x00 0x00]` |
| `0x0b` | SERVER_TEXT | S→C | `[0x0b][len][texto][0x03]` — mensaje de texto del servidor |
| `0x0c` | KEEPALIVE | C↔S | 1 byte — ping/pong, se devuelve tal cual |
| `0x0d` | RELEASE_PTT | C→S | 1 byte — el cliente suelta el canal |
| `0x14` | ROOM_LIST | S→C | `[0x14][count][0x00 0x00 0x00][len name]*` |
| `0x15` | CLIENT_INFO | C→S | 9 bytes — información de versión del cliente (descartado) |
| `0x16` | USER_UPDATE | S→C | Evento de usuarios (ver §3.3.2) |
| `0x1a` | JOIN | C→S | `[0x1a][nickLen][nick][roomLen][room][msgLen][msg][pwdLen][pwd][0x00]` |

#### 3.3.2 Formato de paquete USER_UPDATE (0x16)

**Evento único (count=1):**
```
[0x16][0x01][0x00][0x00][0x00][action][0x00][0x00][0x00][nameLen][name]
  + si action=0x00: [msgLen][msg][0x00]
```

**Lista múltiple (count>1):**
```
Cabecera: [0x16][count][0x00][0x00][0x00]      ← 5 bytes
Por entrada: [action][0x00][0x00][0x00][nameLen][name]
           + si action=0x00: [msgLen][msg][0x00]
```

**Valores de action:**
| Byte | Evento |
|---|---|
| `0x00` | Usuario entra (join) — incluye mensaje de estado |
| `0x01` | Usuario sale (leave) |
| `0x02` | PTT iniciado (empieza a transmitir) |
| `0x03` | PTT liberado (deja de transmitir) |

#### 3.3.3 Audio

- Codec: **GSM 06.10 full-rate** (libgsm)
- 6 tramas × 33 bytes = **198 bytes por paquete**
- Cada trama codifica 20 ms a 8 kHz → 120 ms por paquete (~8,3 paquetes/s)
- Magic nibble GSM `0xD` en offsets: 0, 33, 66, 99, 132, 165

#### 3.3.4 Flujo de conexión TCP

```
Cliente                          Servidor
   │── [0x0a][var][0x00 0x00 0x00] ──▶│  Handshake
   │◀── [0x0a 0xfa 0x00 0x00 0x00] ──│  Respuesta handshake
   │◀── [0x14][count]...             │  Lista de salas
   │── [0x1a][nick][room][msg][pwd] ──▶│  JOIN
   │◀── [0x16][count]...             │  Lista de usuarios (incluye al propio cliente)
   │◀── [0x0c]                        │  Keepalive cada 30s
   │── [0x0c]                       ──▶│  Eco keepalive
```

**Nota:** El cliente Windows v1.13 usa `0x78` como segundo byte del handshake. El servidor acepta cualquier variante que empiece por `0x0a`.

### 3.4 WebSocket Bridge (`/ws`)

Protocolo JSON bidireccional para el cliente web. Soporta dos modos:

#### Modo local
El cliente web actúa como estación conectada directamente al servidor Linux.

**Mensajes cliente → servidor (JSON):**
```jsonc
{ "type": "select_server", "mode": "local" }
{ "type": "join", "room": "CB", "message": "...", "token": "..." }
{ "type": "ptt_start" }
{ "type": "ptt_end" }
{ "type": "ping" }
```

**Mensajes servidor → cliente (JSON):**
```jsonc
{ "type": "room_list", "rooms": ["CB", "ASORAPA", ...] }
{ "type": "joined", "room": "CB", "name": "EA1XX", "members": [...] }
{ "type": "user_joined", "name": "EA1YY", "message": "..." }
{ "type": "user_left", "name": "EA1YY" }
{ "type": "ptt_granted" }
{ "type": "ptt_denied", "reason": "Canal ocupado" }
{ "type": "ptt_started", "name": "EA1YY" }
{ "type": "ptt_released", "name": "EA1YY" }
{ "type": "error", "message": "..." }
{ "type": "keepalive" }
```

**Frames binarios:**
| Opcode | Dirección | Contenido |
|---|---|---|
| `0x01` | S→C | Audio local GSM (198 bytes) |
| `0x11` | S→C | Audio remoto Float32 PCM (de eQSO externo, decodificado GSM) |
| `0x05` | C→S | Audio TX Int16 PCM (se codifica a GSM y se envía al eQSO externo) |

#### Modo remoto
El cliente web actúa como proxy hacia un servidor eQSO externo (ASORAPA u otro).

```jsonc
{ "type": "select_server", "mode": "remote", "host": "193.152.83.229", "port": 8008 }
```

El servidor abre una conexión TCP saliente al servidor remoto (`EqsoProxy`), codifica/decodifica el audio GSM en tiempo real con FFmpeg y retransmite los eventos al navegador.

### 3.5 RoomManager

Gestor de estado en memoria (no persistente — se pierde al reiniciar).

| Característica | Detalle |
|---|---|
| Salas fijas | GENERAL, CB, ASORAPA, PRUEBAS |
| Salas dinámicas | Se crean al primer join, se eliminan al quedarse vacías |
| Bloqueo de canal | Una sala solo puede tener 1 transmisor simultáneo |
| Protocolo | TCP (`"tcp"`) y WebSocket (`"ws"`) en el mismo namespace |
| Indicativo único | No permite dos clientes con el mismo callsign (case-insensitive) |

### 3.6 API REST

Base: `/api`

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| POST | `/api/auth/register` | Público | Registro de usuario. El primero se convierte en admin automáticamente |
| POST | `/api/auth/login` | Público | Login. Devuelve token de sesión (24h) |
| GET | `/api/admin/users` | Admin | Lista todos los usuarios |
| PATCH | `/api/admin/users/:id/status` | Admin | Cambiar estado (active/inactive/pending) |
| PATCH | `/api/admin/users/:id/role` | Admin | Cambiar rol (admin/user) |
| PATCH | `/api/admin/users/:id/relay` | Admin | Cambiar tipo radio-enlace (isRelay true/false) |
| PATCH | `/api/admin/users/:id/password` | Admin | Resetear contraseña |
| GET | `/api/servers` | Auth | Lista de servidores eQSO configurados |
| GET | `/api/health` | Público | Estado del servidor |

### 3.7 Autenticación

- **Hash de contraseñas:** `scrypt` (Node.js crypto nativo) con salt aleatorio de 16 bytes
- **Sesiones:** Map en memoria, TTL 24 horas, UUID v4 como token
- **Roles:** `admin` / `user`
- **Estados de usuario:** `pending` → `active` / `inactive`
- **Bootstrap:** El primer usuario registrado se convierte automáticamente en admin y queda activo
- **Prefijo relay:** Los usuarios marcados como `isRelay=true` reciben prefijo `0R-` + formato Maidenhead 6 caracteres

### 3.8 Codec FFmpeg GSM

El servidor usa FFmpeg en modo proceso hijo (streaming stdin/stdout) para:
- **Decodificación (RX):** GSM 06.10 → PCM Int16 @ 8 kHz (para audio recibido de eQSO externo)
- **Codificación (TX):** PCM Int16 @ 8 kHz → GSM 06.10 (para audio enviado desde el navegador)

El encoder tiene ~120 ms de latencia de pipeline. El servidor aplica un **PTT tail de 300 ms** al soltar el PTT para asegurar que los últimos frames llegan al servidor eQSO antes de cerrar el canal.

---

## 4. Cliente web — `eqso-client`

### 4.1 Tecnologías

| Componente | Tecnología |
|---|---|
| Framework | React 18 + TypeScript |
| Bundler | Vite 5 |
| Estilos | Tailwind CSS + shadcn/ui |
| Comunicación | WebSocket nativo (`useEqsoClient`) |
| Audio | Web Audio API + AudioWorklet |
| PTT serie | Web Serial API (`usePTTSerial`) |

### 4.2 Hooks principales

#### `useEqsoClient`
Gestiona el ciclo de vida completo de la conexión WebSocket:
- Conexión/desconexión
- JOIN a sala
- PTT start/end
- Recepción de eventos (user_joined, user_left, ptt_started, audio...)
- Mantenimiento de la lista de miembros

#### `useAudio`
Gestiona la captura del micrófono y la reproducción de audio:
- Captura: `getUserMedia` → AudioWorklet `mic-processor-v8` → PCM Int16 → WS (opcode `0x05`)
- Reproducción RX local: GSM binario (opcode `0x01`) → `AudioContext.decodeAudioData`
- Reproducción RX remoto: Float32 PCM (opcode `0x11`) → `AudioContext`
- AGC (Control Automático de Ganancia): target RMS = 0,04
- Requiere HTTPS para acceder a `navigator.mediaDevices` (muestra aviso en HTTP)

#### `usePTTSerial`
PTT por puerto serie (Web Serial API):
- Lee una línea TTY cada 100 ms
- Detecta señal de PTT hardware (cable de foot switch / PTT externo)
- Solo disponible en Chrome/Edge con HTTPS

#### `useServers`
Carga la lista de servidores eQSO desde `/api/servers`.

### 4.3 AudioWorklet

- Nombre del processor: `mic-processor-v8`
- Versión: `23`
- Función: captura frames de micrófono del pipeline de WebAudio y los convierte a PCM Int16 para enviar por WebSocket

### 4.4 Indicativo en modo relay

Los usuarios con `isRelay=true` en la base de datos reciben en la sala el formato:
```
0R-XXXXXX
```
Donde `XXXXXX` es el callsign rellenado a 6 caracteres con la plantilla Maidenhead `AA00AA`.

---

## 5. Despliegue en producción (VM Ubuntu)

### 5.1 Requisitos

| Componente | Versión mínima |
|---|---|
| Ubuntu Server | 22.04 LTS |
| Node.js | 20 LTS |
| pnpm | 8+ |
| FFmpeg | 4+ (con soporte libgsm) |
| PostgreSQL | 14+ |
| Nginx | 1.18+ |

### 5.2 Systemd service

Archivo: `/etc/systemd/system/eqso.service`  
Usuario: `eqso`  
Directorio: `/opt/eqso-asorapa`  
Comando: `node --enable-source-maps artifacts/api-server/dist/index.mjs`

Variables de entorno relevantes:
```
PORT=8080
EQSO_TCP_PORT=2171
EQSO_TCP_PORT_ALT=8008
DATABASE_URL=postgresql://...
SESSION_SECRET=...
EQSO_PASSWORD=           ← vacío = sin contraseña en puerto TCP
NODE_ENV=production
```

### 5.3 Build de producción

```bash
PORT=8080 BASE_PATH=/ NODE_ENV=production \
  pnpm --filter @workspace/eqso-client run build

pnpm --filter @workspace/api-server run build

rm -rf artifacts/api-server/dist/public
cp -r artifacts/eqso-client/dist/public artifacts/api-server/dist/
```

### 5.4 Nginx

Nginx en la VM actúa como proxy inverso:
- Puerto 80/443 → `localhost:8080` (HTTP + WebSocket `/ws`)
- Puerto 443 con TLS (certbot, dominio `asorapa.sytes.net`)

Los puertos TCP 2171 y 8008 van **directamente** al proceso Node.js (no pasan por Nginx).

---

## 6. Limitaciones conocidas

| Limitación | Descripción |
|---|---|
| Sesiones en RAM | Las sesiones de usuario se pierden al reiniciar el servidor |
| Audio requiere HTTPS | `getUserMedia` no está disponible en HTTP puro (aviso amarillo en el cliente web) |
| Un transmisor por sala | El canal de voz es half-duplex; solo una estación puede transmitir simultáneamente |
| GSM 06.10 sin VAD | No hay detección de actividad de voz; el cliente envía audio siempre que el PTT esté activo |
| Web Serial solo Chromium | El PTT por puerto serie (`usePTTSerial`) solo funciona en Chrome/Edge |

---

## 7. Historial de cambios

### v1.0 — Abril 2026
- Servidor TCP eQSO compatible con Windows eQSO v1.13
- Cliente web React (eQSO ASORAPA)
- Protocolo TCP eQSO obtenido por ingeniería inversa del servidor ASORAPA (`193.152.83.229`)
- Soporte puertos 2171 (estándar) y 8008 (ASORAPA)
- Handshake flexible: acepta byte `0x78` (Windows v1.13) y `0x82` (proxy interno)
- Lista de usuarios correcta tras JOIN (orden: handshake → lista salas → JOIN → lista usuarios)
- Eliminación de entrada `_SERVER_` espuria de la lista de usuarios
- Sistema de autenticación con registro, aprobación admin y roles
- Modo relay: prefijo `0R-` + formato Maidenhead
- EqsoProxy para conexión a servidores externos con transcoding GSM↔PCM en tiempo real
- Despliegue en VM Ubuntu + systemd + Nginx

---

### v1.1 — Abril 2026
- Nuevo endpoint `PATCH /api/admin/users/:id/relay` para cambiar el tipo radio-enlace de un usuario
- Botón "Hacer enlace / Quitar enlace" en el panel de administración (color naranja cuando es enlace)
- Detalle en especificaciones de todas las rutas admin con sus métodos HTTP correctos

---

*Documento mantenido en el repositorio. Actualizar con cada nueva funcionalidad.*
