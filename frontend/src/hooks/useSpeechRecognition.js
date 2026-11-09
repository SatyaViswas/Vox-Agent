import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { transcribeAudio } from "../api/voice";

/**
 * Sovereign speech recognition hook powered by Gnani Prisma v3.0.
 *
 * Captures microphone audio via standard MediaRecorder and transcribes
 * via Gnani Prisma v3.0 with Automatic Language Identification (Auto-LID),
 * Code-mixing support, and SaaS context keyterms.
 */
export function useSpeechRecognition({ onFinalTranscript, lang = "indic-auto", autoSilenceStop = true } = {}) {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [detectedLanguage, setDetectedLanguage] = useState(null);
  const [boostInfo, setBoostInfo] = useState(null);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState(null);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const vadIntervalRef = useRef(null);
  const maxTimerRef = useRef(null);
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;

  const isSupported =
    typeof window !== "undefined" &&
    Boolean(
      (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ||
      (window.navigator && (window.navigator.getUserMedia || window.navigator.webkitGetUserMedia))
    );

  const cleanupAudioNodes = useCallback(() => {
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        if (audioContextRef.current.state !== "closed") {
          audioContextRef.current.close().catch(() => {});
        }
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  const stop = useCallback(() => {
    cleanupAudioNodes();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch (err) {
        console.error("Error stopping MediaRecorder:", err);
      }
    } else if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsRecording(false);
  }, [cleanupAudioNodes]);

  const start = useCallback(async () => {
    // Check for Secure Context on mobile
    if (typeof window !== "undefined" && window.isSecureContext === false && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      setError("Mobile browsers block microphone on unencrypted HTTP. Please connect via HTTPS (e.g. https://" + location.host + ") or use localhost.");
      return;
    }

    if (!isSupported) {
      setError(t("voice.notSupported") || "Microphone recording is not supported in this browser. Please use HTTPS or a supported mobile browser.");
      return;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      return;
    }

    setError(null);
    setBoostInfo(null);
    setInterimTranscript("Listening via Gnani Prisma v3.0...");
    audioChunksRef.current = [];

    try {
      // Use permissive, mobile-safe audio constraints (avoids OverconstrainedError on iOS Safari)
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      } catch (constraintErr) {
        // Fallback to basic audio constraint if specific flags are unsupported
        console.warn("Retrying getUserMedia with basic audio constraints:", constraintErr);
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      streamRef.current = stream;

      // Select supported mimeType across Chrome, Android, Safari iOS, etc.
      let mimeType = "";
      if (typeof MediaRecorder !== "undefined") {
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
          mimeType = "audio/webm;codecs=opus";
        } else if (MediaRecorder.isTypeSupported("audio/webm")) {
          mimeType = "audio/webm";
        } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
          mimeType = "audio/mp4";
        } else if (MediaRecorder.isTypeSupported("audio/aac")) {
          mimeType = "audio/aac";
        } else if (MediaRecorder.isTypeSupported("audio/ogg")) {
          mimeType = "audio/ogg";
        }
      }

      const recorderOptions = mimeType ? { mimeType } : undefined;
      const recorder = new MediaRecorder(stream, recorderOptions);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }

        const effectiveType = recorder.mimeType || mimeType || "audio/webm";
        const audioBlob = new Blob(audioChunksRef.current, { type: effectiveType });
        audioChunksRef.current = [];

        if (audioBlob.size < 500) {
          // Empty or accidental tap
          setInterimTranscript("");
          setIsProcessing(false);
          return;
        }

        setIsProcessing(true);
        setInterimTranscript("Transcribing with Gnani Prisma v3.0...");

        try {
          const extension = effectiveType.includes("mp4") || effectiveType.includes("aac")
            ? "mp4"
            : effectiveType.includes("ogg")
            ? "ogg"
            : "webm";
          const result = await transcribeAudio(audioBlob, `speech_input.${extension}`, {
            languageCode: lang,
          });

          const finalTranscript = (result?.transcript || "").trim();
          if (finalTranscript) {
            setDetectedLanguage(result.detected_language_code || null);
            setBoostInfo({
              userEntitiesBoosted: result.user_entities_boosted || 0,
              keytermsApplied: result.keyterms_applied || [],
              topic: result.topic,
              model: result.model,
              processingTime: result.processing_time,
            });
            onFinalRef.current?.(finalTranscript, result.detected_language_code, result);
          }
          setInterimTranscript("");
        } catch (err) {
          console.error("Gnani Prisma transcription error:", err);
          setError(err.message || "Failed to transcribe audio with Gnani Prisma.");
          setInterimTranscript("");
        } finally {
          setIsProcessing(false);
        }
      };

      recorder.start(250); // Slice into 250ms chunks
      setIsRecording(true);

      // Voice Activity Detection (VAD): auto-submits on 1.6s silence after user speaks
      if (autoSilenceStop) {
        try {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (AudioContextClass) {
            const audioCtx = new AudioContextClass();
            if (audioCtx.state === "suspended") {
              audioCtx.resume().catch(() => {});
            }
            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);

            audioContextRef.current = audioCtx;
            analyserRef.current = analyser;

            const sampleData = new Uint8Array(analyser.frequencyBinCount);
            let hasSpoken = false;
            let silenceStartTime = null;

            vadIntervalRef.current = setInterval(() => {
              if (!analyserRef.current || !mediaRecorderRef.current || mediaRecorderRef.current.state !== "recording") {
                return;
              }
              analyserRef.current.getByteTimeDomainData(sampleData);
              let sum = 0;
              for (let i = 0; i < sampleData.length; i++) {
                const val = (sampleData[i] - 128) / 128;
                sum += val * val;
              }
              const rms = Math.sqrt(sum / sampleData.length);

              // RMS threshold for human speech vs background noise (tuned for mobile mics)
              if (rms > 0.018) {
                hasSpoken = true;
                silenceStartTime = null;
              } else if (hasSpoken) {
                if (silenceStartTime === null) {
                  silenceStartTime = Date.now();
                } else if (Date.now() - silenceStartTime >= 850) {
                  // 850ms of silence detected after speaking -> auto-submit!
                  cleanupAudioNodes();
                  stop();
                }
              }
            }, 100);

            // Safety max duration: 25s
            maxTimerRef.current = setTimeout(() => {
              if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                cleanupAudioNodes();
                stop();
              }
            }, 25000);
          }
        } catch (vadErr) {
          console.warn("[VAD] Voice Activity Detection setup skipped:", vadErr);
        }
      }
    } catch (err) {
      console.error("Microphone access failed:", err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setError(t("voice.micDenied") || "Microphone access denied. Please grant permission.");
      } else {
        setError(t("voice.startFailed") || "Could not start microphone.");
      }
      setIsRecording(false);
      setInterimTranscript("");
    }
  }, [isSupported, t]);

  const toggle = useCallback(() => {
    if (isRecording) {
      stop();
    } else {
      start();
    }
  }, [isRecording, start, stop]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      cleanupAudioNodes();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [cleanupAudioNodes]);

  return {
    isSupported,
    isRecording,
    isProcessing,
    detectedLanguage,
    boostInfo,
    interimTranscript,
    error,
    start,
    stop,
    toggle,
  };
}

export default useSpeechRecognition;
