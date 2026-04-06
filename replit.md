# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **WebSockets**: ws library (eQSO bridge)

## Artifacts

### eQSO Linux Client (`artifacts/eqso-client`)
- React + Vite web app at `/`
- Web client for eQSO radio linking over internet
- Connects to eQSO server via WebSocket at `/ws`
- Push-to-talk (PTT) with Web Audio API (AudioWorklet, 8kHz PCM, ~122ms/chunk)
- Room management and user list

### API Server (`artifacts/api-server`)
- Express 5 HTTP server at `/api`
- **eQSO TCP Server** — listens on port 2171, fully compatible with existing eQSO Windows clients
- **eQSO WebSocket Bridge** — at `/ws`, serves the web client
- Both share the same RoomManager for cross-client audio relay

## eQSO Protocol

The eQSO server implements the binary protocol reverse-engineered from OSQe:
- `0x0a` handshake, `0x1a` join room, `0x01` + 198 bytes audio, `0x0d` PTT release
- `0x16` user list updates, `0x14` room list, `0x0c` keepalive
- TCP Windows clients and WebSocket Linux clients share the same room/audio bus

## TX Audio Pipeline (Browser)

Cadena: `MediaStream → micGain(×8) → DynamicsCompressor → AnalyserNode → AudioWorkletNode(mic-processor)`

- **AudioWorklet** (`public/mic-worklet.js`): procesa bloques de 128 muestras en el hilo de audio (2.67ms@48kHz). Submuestrea a 8kHz y acumula hasta 960 muestras → emite chunk cada ~122ms ≈ real-time. Reemplaza ScriptProcessorNode que entregaba chunks cada 255–340ms (solo 47% de velocidad real), causando que ASORAPA vaciara el buffer de audio en 2s.
- **Warmup**: 0.5s descartado en el worklet (≈188 bloques) para que el hardware del micrófono se estabilice.
- **DynamicsCompressor**: threshold=-30dBFS, ratio=8, attack=3ms, release=150ms. Normaliza niveles variables para mantener el squelch de la radio receptora abierto.
- **Cadena de timing**: PTT start → worklet warmup 500ms → chunks cada 122ms → servidor encode GSM → ASORAPA recibe audio a tiempo real.

## GSM 06.10 Codec

Audio uses GSM 06.10 (libgsm) codec: 198 bytes / 120ms / 8 kHz mono.

**Implementation**: `artifacts/api-server/src/eqso/ffmpeg-gsm.ts`
- `FfmpegGsmDecoder`: streaming ffmpeg process (GSM → PCM). Pre-started at connection, ~500ms startup, <10ms per packet.
- `FfmpegGsmEncoder`: streaming ffmpeg process (PCM → GSM). Same timing.
- The old TypeScript hand-rolled implementation (`gsm610.ts`) was 55x too quiet and had 0 dB SNR encoder. Replaced by ffmpeg/libgsm via piped child processes.
- ffmpeg command decode: `ffmpeg -probesize 32 -f gsm -ar 8000 -i pipe:0 -f s16le -ar 8000 pipe:1`
- ffmpeg command encode: `ffmpeg -probesize 32 -f s16le -ar 8000 -ac 1 -i pipe:0 -f gsm -ar 8000 pipe:1`
- Round-trip SNR: 20.1 dB. Decoder peak: 3568/32768 (~-19 dBFS). Browser gain node: 3x → ~-9 dBFS comfortable listening.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
