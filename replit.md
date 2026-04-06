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

Cadena: `MediaStream → micGain(×8) → WaveShaperNode(tanh soft-clip) → AnalyserNode → AudioWorkletNode(mic-processor)`

- **AudioWorklet** (`public/mic-worklet.js`): procesa bloques de 128 muestras en el hilo de audio (2.67ms@48kHz). **Anti-aliasing**: box-filter FIR (media de `ratio` muestras consecutivas antes de decimar, corte ≈3.5kHz para 48→8kHz). **Carry buffer entre bloques**: 128 mod 6 = 2 muestras sobrantes se propagaban al siguiente bloque. Sin esto, se descartan 2 muestras cada 2.67ms → discontinuidad a 375Hz → artefacto tonal audible ("voz distorsionada"). Con carry buffer, TODAS las muestras se usan y la tasa de salida es exactamente 8000Hz.
- **Warmup**: 0.5s descartado en el worklet (≈188 bloques) para que el hardware del micrófono se estabilice.
- **WaveShaperNode (soft-clipper tanh)**: curva tanh(2x)/tanh(2), oversample="4x". Reemplaza DynamicsCompressor (Chrome aplica make-up gain automático que empujaba la señal >1.0 Float32 → hard clipping severo al convertir a Int16). El tanh limita suavemente sin pumping ni artefactos. Gain ×8 (nivel suficiente para VOX de la radio receptora).
- **Cadena de timing**: PTT start → worklet warmup 500ms → chunks cada 122ms → servidor encode GSM → ASORAPA recibe audio a tiempo real.

## GSM 06.10 Codec

Audio uses GSM 06.10 (libgsm) codec: 198 bytes / 120ms / 8 kHz mono.

**TX Encoder**: `TsGsmEncoder` (`gsm610.ts` + `ffmpeg-gsm.ts`)
- Pure TypeScript, synchronous per-frame encoding using the `GsmEncoder` class.
- Emits `"gsm"` event immediately (no buffering). Critical for real-time TX.
- `FfmpegGsmEncoder` was abandoned: ffmpeg internal pipe requires ~50+ packets before flushing — unusable for real-time audio.

**RX Decoder**: `FfmpegGsmDecoder` (`ffmpeg-gsm.ts`)
- Streaming ffmpeg process (GSM → PCM Int16). Pre-started at connection.
- Peaks 2000–7480 (healthy speech levels). Pure-TS decoder had bugs (silent audio).
- ffmpeg command: `ffmpeg -probesize 32 -f gsm -ar 8000 -i pipe:0 -f s16le -ar 8000 pipe:1`

## PTT Race Condition Fix

`pttPendingRef` + `pendingAudioRef` (max 8 chunks) in `useEqsoClient.ts`:
- Audio chunks arriving before `ptt_granted` are buffered (not dropped).
- On `ptt_granted`: buffered chunks are flushed in order, then normal streaming continues.
- Buffer cleared on `ptt_released`, `ptt_denied`, disconnect, WS `onclose`.

## Production Deployment

- **API server**: Replit — `wss://code-translator-linux.replit.app/ws`
- **Web client**: GitHub Pages — `https://daycart.github.io/eqso-linux-client/`
  - Deployed via GitHub Actions CI/CD on push to `daycart/eqso-linux-client` main branch.
  - Client changes must be pushed via GitHub API (bash, not code_execution).
  - Build requires `PORT` and `BASE_PATH` env vars (handled by CI).

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
