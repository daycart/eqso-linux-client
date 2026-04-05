import { useCallback, useEffect, useRef, useState } from "react";

export interface UseAudioReturn {
  isRecording: boolean;
  isMicAllowed: boolean | null;
  startRecording: (onChunk: (data: ArrayBuffer) => void, mode?: "local" | "remote") => Promise<void>;
  stopRecording: () => void;
  playAudio: (data: ArrayBuffer, isFloat32?: boolean) => void;
  inputLevel: number;
}

// Local mode: Uint8 unsigned PCM, 160 bytes per chunk
const LOCAL_CHUNK_BYTES = 160;
// Remote mode: Int16 signed PCM, 960 samples (6 GSM frames × 160) per chunk = 1920 bytes
const REMOTE_CHUNK_SAMPLES = 960;

export function useAudio(): UseAudioReturn {
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelTimerRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const accumLocalRef = useRef<Uint8Array>(new Uint8Array(0));
  const accumRemoteRef = useRef<Int16Array>(new Int16Array(0));

  const [isRecording, setIsRecording] = useState(false);
  const [isMicAllowed, setIsMicAllowed] = useState<boolean | null>(null);
  const [inputLevel, setInputLevel] = useState(0);

  const getOrCreateCtx = useCallback((): AudioContext => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext({ sampleRate: 8000 });
    }
    if (ctxRef.current.state === "suspended") {
      ctxRef.current.resume();
    }
    return ctxRef.current;
  }, []);

  const startRecording = useCallback(async (
    onChunk: (data: ArrayBuffer) => void,
    mode: "local" | "remote" = "local"
  ) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 8000,
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
        const input = ev.inputBuffer.getChannelData(0); // Float32, length=BUFFER_SIZE

        if (mode === "local") {
          // Convert Float32 → Uint8 (unsigned 8-bit, range 0–255) for local relay
          const pcm8 = new Uint8Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
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
          // Convert Float32 → Int16 for GSM encoding on server
          const pcm16 = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            pcm16[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
          }
          const merged = new Int16Array(accumRemoteRef.current.length + pcm16.length);
          merged.set(accumRemoteRef.current);
          merged.set(pcm16, accumRemoteRef.current.length);
          accumRemoteRef.current = merged;

          while (accumRemoteRef.current.length >= REMOTE_CHUNK_SAMPLES) {
            const chunk = accumRemoteRef.current.slice(0, REMOTE_CHUNK_SAMPLES);
            accumRemoteRef.current = accumRemoteRef.current.slice(REMOTE_CHUNK_SAMPLES);
            // chunk is Int16Array (960 samples = 1920 bytes)
            onChunk(chunk.buffer);
          }
        }
      };

      source.connect(processor);
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
   * Play received audio.
   * @param data    Raw bytes (without the opcode header byte).
   * @param isFloat32  true = Float32 PCM (from remote GSM decode); false = Uint8 unsigned PCM (local).
   */
  const playAudio = useCallback((data: ArrayBuffer, isFloat32 = false) => {
    try {
      const ctx = getOrCreateCtx();
      let float32: Float32Array;

      if (isFloat32) {
        // Data is already Float32 PCM from the server GSM decoder
        const raw = new Float32Array(data);
        float32 = new Float32Array(raw.length);
        float32.set(raw);
      } else {
        // Unsigned 8-bit PCM → Float32
        const pcm8 = new Uint8Array(data);
        float32 = new Float32Array(pcm8.length);
        for (let i = 0; i < pcm8.length; i++) {
          float32[i] = (pcm8[i] / 127.5) - 1.0;
        }
      }

      if (float32.length === 0) return;

      const buffer = ctx.createBuffer(1, float32.length, 8000);
      buffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
    } catch {
      // Ignore playback errors
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
    inputLevel,
  };
}
