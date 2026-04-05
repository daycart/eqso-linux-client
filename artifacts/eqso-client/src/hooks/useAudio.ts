import { useCallback, useEffect, useRef, useState } from "react";

export interface UseAudioReturn {
  isRecording: boolean;
  isMicAllowed: boolean | null;
  startRecording: (onChunk: (data: ArrayBuffer) => void, mode?: "local" | "remote") => Promise<void>;
  stopRecording: () => void;
  playAudio: (data: ArrayBuffer, isFloat32?: boolean) => void;
  resumeContext: () => void;
  inputLevel: number;
}

// Remote mode: Int16 signed PCM, 960 samples (6 GSM frames × 160) per chunk = 1920 bytes
const REMOTE_CHUNK_SAMPLES = 960;
// Local mode: Uint8 unsigned PCM, 160 bytes per chunk
const LOCAL_CHUNK_BYTES = 160;
// Target sample rate for GSM encoding
const GSM_RATE = 8000;

/**
 * Linear-interpolation downsampler.
 * Only used when the AudioContext native rate ≠ 8000 Hz.
 */
function downsampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = input[j] ?? 0;
    const b = input[Math.min(j + 1, input.length - 1)];
    out[i] = a + frac * (b - a);
  }
  return out;
}

// Maximum seconds we allow the scheduler to fall behind before resetting.
// If the browser pauses (tab hidden, slow CPU) we don't want a huge backlog.
const MAX_QUEUE_AHEAD_SEC = 1.5;

export function useAudio(): UseAudioReturn {
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelTimerRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const accumLocalRef = useRef<Uint8Array>(new Uint8Array(0));
  const accumRemoteRef = useRef<Int16Array>(new Int16Array(0));
  // Tracks the AudioContext time at which the next buffer should start.
  // Buffers are chained end-to-end so they play without gaps or overlaps.
  const nextPlayTimeRef = useRef<number>(0);
  // GainNode shared across all playback — amplifies decoded GSM which is quiet.
  const gainNodeRef = useRef<GainNode | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [isMicAllowed, setIsMicAllowed] = useState<boolean | null>(null);
  const [inputLevel, setInputLevel] = useState(0);

  /**
   * Get or create the AudioContext and the shared GainNode.
   * Always uses the browser's preferred native sample rate.
   */
  const getOrCreateCtx = useCallback((): AudioContext => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
      const gain = ctxRef.current.createGain();
      // GSM 06.10 decoded via libgsm/ffmpeg: typical speech peaks at ~3500/32768
      // (~-19 dBFS). 3x gain brings typical speech to ~-9 dBFS — comfortable
      // listening level with headroom for loud stations.
      gain.gain.value = 3;
      gain.connect(ctxRef.current.destination);
      gainNodeRef.current = gain;
      nextPlayTimeRef.current = 0;
    }
    if (ctxRef.current.state === "suspended") {
      ctxRef.current.resume().catch(() => {});
    }
    return ctxRef.current;
  }, []);

  /**
   * Call this from a user-gesture handler (button click, keydown) so the
   * browser allows audio playback via the autoplay policy.
   */
  const resumeContext = useCallback(() => {
    const ctx = getOrCreateCtx();
    if (ctx.state !== "running") {
      ctx.resume().catch(() => {});
    }
  }, [getOrCreateCtx]);

  const startRecording = useCallback(async (
    onChunk: (data: ArrayBuffer) => void,
    mode: "local" | "remote" = "local"
  ) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      setIsMicAllowed(true);
      streamRef.current = stream;
      accumLocalRef.current = new Uint8Array(0);
      accumRemoteRef.current = new Int16Array(0);

      const ctx = getOrCreateCtx();
      // Resume during this user-gesture context (PTT press)
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
      const nativeRate = ctx.sampleRate;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      source.connect(analyser);

      const BUFFER_SIZE = 4096;
      const processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (ev) => {
        // inputBuffer is at nativeRate (e.g. 44100 or 48000 Hz)
        const rawInput = ev.inputBuffer.getChannelData(0);

        if (mode === "local") {
          // Downsample to 8000 Hz then convert to Uint8
          const resampled = downsampleFloat32(rawInput, nativeRate, GSM_RATE);
          const pcm8 = new Uint8Array(resampled.length);
          for (let i = 0; i < resampled.length; i++) {
            const s = Math.max(-1, Math.min(1, resampled[i]));
            pcm8[i] = Math.round((s + 1) * 127.5);
          }
          const merged = new Uint8Array(accumLocalRef.current.length + pcm8.length);
          merged.set(accumLocalRef.current);
          merged.set(pcm8, accumLocalRef.current.length);
          accumLocalRef.current = merged;

          while (accumLocalRef.current.length >= LOCAL_CHUNK_BYTES) {
            onChunk(accumLocalRef.current.slice(0, LOCAL_CHUNK_BYTES).buffer);
            accumLocalRef.current = accumLocalRef.current.slice(LOCAL_CHUNK_BYTES);
          }
        } else {
          // Downsample to 8000 Hz then convert to Int16 for GSM encoding on server
          const resampled = downsampleFloat32(rawInput, nativeRate, GSM_RATE);
          const pcm16 = new Int16Array(resampled.length);
          for (let i = 0; i < resampled.length; i++) {
            const s = Math.max(-1, Math.min(1, resampled[i]));
            pcm16[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
          }
          const merged = new Int16Array(accumRemoteRef.current.length + pcm16.length);
          merged.set(accumRemoteRef.current);
          merged.set(pcm16, accumRemoteRef.current.length);
          accumRemoteRef.current = merged;

          while (accumRemoteRef.current.length >= REMOTE_CHUNK_SAMPLES) {
            const chunk = accumRemoteRef.current.slice(0, REMOTE_CHUNK_SAMPLES);
            accumRemoteRef.current = accumRemoteRef.current.slice(REMOTE_CHUNK_SAMPLES);
            onChunk(chunk.buffer);
          }
        }
      };

      source.connect(processor);
      // Must connect to destination for onaudioprocess to fire;
      // the output buffer stays silent (we never write to it)
      processor.connect(ctx.destination);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setInputLevel(avg / 255);
        levelTimerRef.current = requestAnimationFrame(updateLevel);
      };
      levelTimerRef.current = requestAnimationFrame(updateLevel);

      setIsRecording(true);
    } catch {
      setIsMicAllowed(false);
      setIsRecording(false);
    }
  }, [getOrCreateCtx]);

  const stopRecording = useCallback(() => {
    if (levelTimerRef.current) {
      cancelAnimationFrame(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    processorRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    accumLocalRef.current = new Uint8Array(0);
    accumRemoteRef.current = new Int16Array(0);
    setIsRecording(false);
    setInputLevel(0);
  }, []);

  /**
   * Play received audio using a sequential scheduler.
   * Each buffer is chained to start exactly when the previous one ends,
   * preventing overlapping playback when packets arrive in bursts.
   *
   * @param data      Raw bytes (without the opcode header byte).
   * @param isFloat32 true = Float32 PCM at 8000 Hz (remote GSM decoded);
   *                  false = Uint8 unsigned PCM at 8000 Hz (local relay).
   */
  const playAudio = useCallback((data: ArrayBuffer, isFloat32 = false) => {
    try {
      const ctx = getOrCreateCtx();
      if (ctx.state !== "running") {
        ctx.resume().catch(() => {});
      }

      let float32: Float32Array;

      if (isFloat32) {
        const copy = data.slice(0);
        float32 = new Float32Array(copy);
      } else {
        const pcm8 = new Uint8Array(data);
        float32 = new Float32Array(pcm8.length);
        for (let i = 0; i < pcm8.length; i++) {
          float32[i] = (pcm8[i] / 127.5) - 1.0;
        }
      }

      if (float32.length === 0) {
        console.warn("[audio] playAudio: empty buffer");
        return;
      }

      // Audio data is at 8000 Hz; browser resamples automatically when
      // the buffer sampleRate differs from the context sampleRate.
      const buffer = ctx.createBuffer(1, float32.length, GSM_RATE);
      buffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      // Route through the shared gain node for volume amplification.
      source.connect(gainNodeRef.current ?? ctx.destination);

      // ── Sequential scheduling ─────────────────────────────────────────────
      // If the scheduler has fallen far behind (e.g. long silence, tab hidden),
      // reset nextPlayTime to "now" so we don't queue a massive backlog.
      const now = ctx.currentTime;
      if (nextPlayTimeRef.current < now || nextPlayTimeRef.current > now + MAX_QUEUE_AHEAD_SEC) {
        nextPlayTimeRef.current = now;
      }
      source.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += buffer.duration;

      console.debug(`[audio] playAudio: ${float32.length} samples, ctx=${ctx.state}, lag=${(nextPlayTimeRef.current - now).toFixed(3)}s`);
    } catch (err) {
      console.error("[audio] playAudio error:", err);
    }
  }, [getOrCreateCtx]);

  useEffect(() => {
    return () => {
      stopRecording();
      ctxRef.current?.close();
    };
  }, [stopRecording]);

  return {
    isRecording,
    isMicAllowed,
    startRecording,
    stopRecording,
    playAudio,
    resumeContext,
    inputLevel,
  };
}
