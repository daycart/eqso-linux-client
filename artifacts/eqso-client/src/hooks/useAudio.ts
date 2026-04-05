import { useCallback, useEffect, useRef, useState } from "react";

export interface UseAudioReturn {
  isRecording: boolean;
  isMicAllowed: boolean | null;
  startRecording: (onChunk: (data: ArrayBuffer) => void) => Promise<void>;
  stopRecording: () => void;
  playAudio: (data: ArrayBuffer) => void;
  inputLevel: number;
}

export function useAudio(): UseAudioReturn {
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelTimerRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

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

  const startRecording = useCallback(async (onChunk: (data: ArrayBuffer) => void) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 8000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      setIsMicAllowed(true);
      streamRef.current = stream;

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
        const input = ev.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        onChunk(pcm16.buffer);
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

    setIsRecording(false);
    setInputLevel(0);
  }, []);

  const playAudio = useCallback((data: ArrayBuffer) => {
    try {
      const ctx = getOrCreateCtx();
      const pcm16 = new Int16Array(data);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
      }

      const buffer = ctx.createBuffer(1, float32.length, 8000);
      buffer.copyToChannel(float32, 0);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
    } catch {
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
