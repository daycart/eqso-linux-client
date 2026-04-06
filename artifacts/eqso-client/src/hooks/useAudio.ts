import { useCallback, useEffect, useRef, useState } from "react";

export interface UseAudioReturn {
  isRecording: boolean;
  isMicAllowed: boolean | null;
  startRecording: (onChunk: (data: ArrayBuffer) => void, mode?: "local" | "remote") => Promise<void>;
  stopRecording: () => void;
  playAudio: (data: ArrayBuffer, isFloat32?: boolean) => void;
  resumeContext: () => void;
  inputLevel: number;
  /** Mute or unmute RX audio (use during TX to prevent acoustic feedback). */
  muteRx: (muted: boolean) => void;
}

// Remote mode: Int16 signed PCM, 960 samples (6 GSM frames × 160) per chunk = 1920 bytes
const REMOTE_CHUNK_SAMPLES = 960;
// Local mode: Uint8 unsigned PCM, 160 bytes per chunk
const LOCAL_CHUNK_BYTES = 160;
// Target sample rate for GSM encoding
const GSM_RATE = 8000;

// Maximum seconds we allow the scheduler to fall behind before resetting.
const MAX_QUEUE_AHEAD_SEC = 1.5;

// Warmup: discard the first 80 ms of mic audio to absorb hardware startup pop.
// 80 ms is enough; 500 ms was wasting ~400 ms of every PTT press.
const TX_WARMUP_SECONDS = 0.08;

export function useAudio(): UseAudioReturn {
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelTimerRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const accumLocalRef = useRef<Uint8Array>(new Uint8Array(0));
  const accumRemoteRef = useRef<Int16Array>(new Int16Array(0));
  const nextPlayTimeRef = useRef<number>(0);
  const gainNodeRef = useRef<GainNode | null>(null);

  // The chunk callback and mode are stored in refs so they can be updated on
  // each PTT press without recreating the worklet message handler.
  const onChunkRef = useRef<((data: ArrayBuffer) => void) | null>(null);
  const modeRef = useRef<"local" | "remote">("remote");

  // Mic initialization state: prevents opening the mic multiple times.
  const micInitializedRef = useRef(false);
  const micInitPromiseRef = useRef<Promise<void> | null>(null);
  // Guards against emitting audio if PTT is released before getUserMedia resolves.
  const pttActiveRef = useRef(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isMicAllowed, setIsMicAllowed] = useState<boolean | null>(null);
  const [inputLevel, setInputLevel] = useState(0);

  const getOrCreateCtx = useCallback((): AudioContext => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
      const gain = ctxRef.current.createGain();
      // GSM 06.10 decoded via ffmpeg: typical speech peaks at ~3500/32768
      // (~-19 dBFS). 3× gain brings typical speech to ~-9 dBFS.
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

  const resumeContext = useCallback(() => {
    const ctx = getOrCreateCtx();
    if (ctx.state !== "running") {
      ctx.resume().catch(() => {});
    }
  }, [getOrCreateCtx]);

  /**
   * Tear down the mic chain (source → analyser → worklet → silentSink).
   * Called when the mic track ends (device disconnected/switched) so the next
   * PTT press runs getUserMedia again against the new hardware.
   */
  const releaseMic = useCallback(() => {
    if (levelTimerRef.current !== null) {
      cancelAnimationFrame(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    try { processorRef.current?.port.postMessage({ type: "emit", emitting: false }); } catch { /* ignore */ }
    try { processorRef.current?.disconnect(); } catch { /* ignore */ }
    try { analyserRef.current?.disconnect(); } catch { /* ignore */ }
    try { sourceRef.current?.disconnect(); } catch { /* ignore */ }
    streamRef.current?.getTracks().forEach(t => t.stop());
    processorRef.current  = null;
    analyserRef.current   = null;
    sourceRef.current     = null;
    streamRef.current     = null;
    micInitializedRef.current  = false;
    micInitPromiseRef.current  = null;
    setInputLevel(0);
    console.debug("[audio] mic released — will re-init on next PTT");
  }, []);

  /**
   * Initialize the microphone and audio worklet chain ONCE per session.
   * The worklet runs continuously in "silent" mode (emitting=false) between
   * PTT presses — no getUserMedia delay on subsequent presses.
   *
   * If the user plugs/unplugs headphones the track fires onended → releaseMic()
   * resets all refs → the very next PTT call runs getUserMedia against the new
   * hardware automatically.
   */
  const initMicOnce = useCallback(async (mode: "local" | "remote"): Promise<void> => {
    if (micInitializedRef.current) return;

    // Deduplicate concurrent init calls (e.g. very fast double-click)
    if (micInitPromiseRef.current) return micInitPromiseRef.current;

    const doInit = async () => {
      try {
        console.debug(`[audio] initMic: requesting mic (mode=${mode})`);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            // Disable OS AGC: the worklet applies its own fixed gain×tanh soft-clip.
            // With autoGainControl=true the OS boosts the mic to near-saturation
            // before our worklet sees it, causing double-amplification and heavy
            // tanh clipping → distorted, "crushed" audio at the radio.
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false,
          },
          video: false,
        });
        const tracks = stream.getAudioTracks();
        console.debug(`[audio] mic granted: ${tracks.length} track(s)`, tracks.map(t => t.label));
        setIsMicAllowed(true);
        streamRef.current = stream;

        // When the OS switches the audio device (e.g. user plugs in headphones)
        // the active track fires "ended" and its samples become all-zeros.
        // Release the dead chain so the next PTT calls getUserMedia afresh.
        tracks.forEach(track => {
          track.onended = () => releaseMic();
        });

        const ctx = getOrCreateCtx();
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const nativeRate = ctx.sampleRate;

        const source = ctx.createMediaStreamSource(stream);
        sourceRef.current = source;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;
        source.connect(analyser);

        const workletUrl = import.meta.env.BASE_URL + "mic-worklet.js";
        try {
          await ctx.audioWorklet.addModule(workletUrl);
        } catch {
          // Already registered — safe to ignore.
        }

        const warmupBlocks = Math.round(TX_WARMUP_SECONDS * nativeRate / 128);
        const workletNode = new AudioWorkletNode(ctx, "mic-processor", {
          processorOptions: {
            nativeRate,
            targetRate:   GSM_RATE,
            chunkSamples: REMOTE_CHUNK_SAMPLES,
            warmupBlocks,
          },
          numberOfOutputs: 1,
        });
        processorRef.current = workletNode;

        workletNode.port.onmessage = (ev) => {
          const msg = ev.data as { type: string; data?: Float32Array; rms?: number; peak?: number; gain?: number };

          if (msg.type === "ready") {
            console.debug("[audio] worklet warmup complete — ready for PTT");
            return;
          }

          if (msg.type === "level") {
            console.debug(
              `[audio] TX mic (gain×${msg.gain?.toFixed(2)})`,
              `rms=${msg.rms?.toFixed(4)} peak48k=${msg.peak?.toFixed(4)} peak8k=${(msg as any).peak8k?.toFixed(4)} rate=${nativeRate}`
            );
            return;
          }

          if (msg.type !== "chunk") return;
          const float32 = msg.data as Float32Array;
          const onChunk = onChunkRef.current;
          if (!onChunk) return;

          if (modeRef.current === "local") {
            const pcm8 = new Uint8Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
              const s = Math.max(-1, Math.min(1, float32[i]));
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
            const pcm16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
              const s = Math.max(-1, Math.min(1, float32[i]));
              pcm16[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
            }
            console.debug("[ptt] audio chunk:", pcm16.byteLength, "bytes");
            onChunk(pcm16.buffer);
          }
        };

        // The worklet must be connected to something for Chrome to keep the
        // audio graph alive, but we MUST NOT connect it to ctx.destination —
        // that would play the raw mic audio through the speakers and create
        // an acoustic echo/feedback loop.  A muted GainNode acts as a silent
        // sink that satisfies the Web Audio engine without any audible output.
        const silentSink = ctx.createGain();
        silentSink.gain.value = 0;
        silentSink.connect(ctx.destination);

        analyser.connect(workletNode);
        workletNode.connect(silentSink);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const updateLevel = () => {
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          setInputLevel(avg / 255);
          levelTimerRef.current = requestAnimationFrame(updateLevel);
        };
        levelTimerRef.current = requestAnimationFrame(updateLevel);

        micInitializedRef.current = true;
        console.debug("[audio] mic chain initialized, worklet running");
      } catch (err) {
        console.error("[audio] mic init error:", err);
        setIsMicAllowed(false);
        micInitPromiseRef.current = null;
      }
    };

    micInitPromiseRef.current = doInit();
    return micInitPromiseRef.current;
  }, [getOrCreateCtx, releaseMic]);

  /**
   * Start recording — open the mic (first call only) then signal the worklet
   * to begin emitting audio chunks.  On subsequent PTT presses the mic is
   * already warm, so audio starts within a single 128-sample worklet block
   * (~2.7 ms at 48 kHz) with no getUserMedia round-trip.
   */
  const startRecording = useCallback(async (
    onChunk: (data: ArrayBuffer) => void,
    mode: "local" | "remote" = "local"
  ) => {
    // Update the chunk handler and mode for this PTT press
    onChunkRef.current = onChunk;
    modeRef.current = mode;
    pttActiveRef.current = true;
    accumLocalRef.current = new Uint8Array(0);
    accumRemoteRef.current = new Int16Array(0);

    // If the mic was already open but the track ended (e.g. user plugged in
    // headphones after the first PTT), the stream produces all-zeros.  Detect
    // this before signalling the worklet and force a re-init with the new device.
    if (micInitializedRef.current && streamRef.current) {
      const dead = streamRef.current.getAudioTracks().some(t => t.readyState === "ended");
      if (dead) {
        console.debug("[audio] mic track ended — releasing for re-init");
        releaseMic();
      }
    }

    // Initialize mic if not done yet (first PTT only; subsequent calls are instant)
    await initMicOnce(mode);

    // Guard: PTT might have been released while getUserMedia was pending
    if (!pttActiveRef.current) {
      console.debug("[audio] PTT released during mic init — not emitting");
      return;
    }

    // Signal the worklet to start emitting chunks
    if (processorRef.current) {
      processorRef.current.port.postMessage({ type: "emit", emitting: true });
    }

    setIsRecording(true);
  }, [initMicOnce, releaseMic]);

  /**
   * Stop recording — signal the worklet to stop emitting.
   * The mic stream and audio chain stay alive for the next PTT press.
   */
  const stopRecording = useCallback(() => {
    pttActiveRef.current = false;
    if (processorRef.current) {
      processorRef.current.port.postMessage({ type: "emit", emitting: false });
    }
    onChunkRef.current = null;
    accumLocalRef.current = new Uint8Array(0);
    accumRemoteRef.current = new Int16Array(0);
    setIsRecording(false);
    setInputLevel(0);
  }, []);

  /**
   * Full teardown — called on component unmount.
   * Closes the mic stream and AudioContext.
   */
  const teardown = useCallback(() => {
    if (levelTimerRef.current) {
      cancelAnimationFrame(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.port.postMessage({ type: "emit", emitting: false });
      processorRef.current.port.onmessage = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    micInitializedRef.current = false;
    micInitPromiseRef.current = null;
    pttActiveRef.current = false;
    onChunkRef.current = null;
    accumLocalRef.current = new Uint8Array(0);
    accumRemoteRef.current = new Int16Array(0);
    setIsRecording(false);
    setInputLevel(0);
  }, []);

  const playAudio = useCallback((data: ArrayBuffer, isFloat32 = false) => {
    try {
      const ctx = getOrCreateCtx();
      if (ctx.state !== "running") {
        ctx.resume().catch(() => {});
      }

      let float32: Float32Array;

      if (isFloat32) {
        float32 = new Float32Array(data.slice(0));
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

      const buffer = ctx.createBuffer(1, float32.length, GSM_RATE);
      buffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gainNodeRef.current ?? ctx.destination);

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

  const muteRx = useCallback((muted: boolean) => {
    const ctx = getOrCreateCtx();
    if (!gainNodeRef.current) return;
    const now = ctx.currentTime;
    gainNodeRef.current.gain.cancelScheduledValues(now);
    gainNodeRef.current.gain.setTargetAtTime(muted ? 0 : 3, now, 0.01);
  }, [getOrCreateCtx]);

  useEffect(() => {
    return () => {
      teardown();
      ctxRef.current?.close();
    };
  }, [teardown]);

  // When the user plugs or unplugs headphones/speakers the browser fires
  // devicechange.  Release the old mic chain so the next PTT press captures
  // audio from the newly selected default device.  Without this, the stream
  // keeps pointing at the stale (possibly ended) track and delivers silence.
  useEffect(() => {
    const onDeviceChange = () => {
      if (!micInitializedRef.current) return;
      console.debug("[audio] devicechange — releasing mic for re-init");
      releaseMic();
    };
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
    };
  }, [releaseMic]);

  return {
    isRecording,
    isMicAllowed,
    startRecording,
    stopRecording,
    playAudio,
    resumeContext,
    inputLevel,
    muteRx,
  };
}
