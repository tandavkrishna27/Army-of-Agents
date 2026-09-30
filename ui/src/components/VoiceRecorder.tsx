import { useState, useRef, useEffect, useCallback } from "react";
import { Mic, Square, Play, Pause, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export type VoiceRecorderStatus = "idle" | "recording" | "stopped";

interface VoiceRecorderProps {
  onRecordingComplete: (blob: Blob) => void;
  disabled?: boolean;
}

const MAX_RECORDING_MS = 10 * 60 * 1000; // 10 minutes
const WAVEFORM_BARS = 40;

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function VoiceRecorder({ onRecordingComplete, disabled }: VoiceRecorderProps) {
  const [status, setStatus] = useState<VoiceRecorderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [waveformData, setWaveformData] = useState<number[]>(() =>
    Array.from({ length: WAVEFORM_BARS }, () => 0),
  );

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Check browser support
  const isSupported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopMediaTracks();
      if (timerRef.current) clearInterval(timerRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopMediaTracks() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  }

  const updateWaveform = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);

    // Sample evenly across the frequency bins
    const step = Math.floor(data.length / WAVEFORM_BARS);
    const bars: number[] = [];
    for (let i = 0; i < WAVEFORM_BARS; i++) {
      const idx = i * step;
      bars.push(data[idx] / 255);
    }
    setWaveformData(bars);

    animFrameRef.current = requestAnimationFrame(updateWaveform);
  }, []);

  async function startRecording() {
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Set up audio analyser for waveform
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Prefer webm, fall back to whatever is available
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        onRecordingComplete(blob);
        stopMediaTracks();
      };

      recorder.start(250); // Collect data every 250ms
      setStatus("recording");
      startTimeRef.current = Date.now();
      setDurationMs(0);

      // Start duration timer
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        setDurationMs(elapsed);

        if (elapsed >= MAX_RECORDING_MS) {
          stopRecording();
        }
      }, 200);

      // Start waveform animation
      updateWaveform();
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access denied. Please allow microphone access in your browser settings."
          : "Failed to access microphone. Please check your device settings.";
      setError(message);
    }
  }

  function stopRecording() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setStatus("stopped");
    setWaveformData(Array.from({ length: WAVEFORM_BARS }, () => 0));
  }

  function resetRecording() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setStatus("idle");
    setDurationMs(0);
    setIsPlaying(false);
    setError(null);
    chunksRef.current = [];
  }

  function togglePlayback() {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  }

  if (!isSupported) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        Voice recording is not supported in this browser.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Waveform visualization */}
      {status === "recording" && (
        <div className="flex h-16 items-end justify-center gap-[2px] rounded-md bg-muted/50 px-3">
          {waveformData.map((v, i) => (
            <div
              key={i}
              className="w-1.5 rounded-full bg-red-500 transition-all duration-75"
              style={{ height: `${Math.max(4, v * 100)}%` }}
            />
          ))}
        </div>
      )}

      {/* Playback after recording */}
      {status === "stopped" && audioUrl && (
        <div className="flex items-center gap-3 rounded-md bg-muted/50 p-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={togglePlayback}
          >
            {isPlaying ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>
          <span className="text-sm text-muted-foreground">
            {formatDuration(durationMs)}
          </span>
          <audio
            ref={audioRef}
            src={audioUrl}
            onEnded={() => setIsPlaying(false)}
            className="hidden"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto text-xs"
            onClick={resetRecording}
          >
            Re-record
          </Button>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-center gap-3">
        {status === "idle" && (
          <Button
            type="button"
            variant="outline"
            onClick={startRecording}
            disabled={disabled}
            className="gap-2"
          >
            <Mic className="h-4 w-4" />
            Start Recording
          </Button>
        )}

        {status === "recording" && (
          <>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              <span className="text-sm font-medium tabular-nums text-red-600">
                {formatDuration(durationMs)}
              </span>
            </div>
            {durationMs >= MAX_RECORDING_MS - 60_000 && (
              <span className="text-xs text-amber-600">
                Max 10 min — stopping soon
              </span>
            )}
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={stopRecording}
              className="gap-2"
            >
              <Square className="h-3 w-3" />
              Stop
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
