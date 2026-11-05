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
    Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

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
    if (!isSupported) {
      setError(t("voice.notSupported") || "Microphone recording is not supported in this browser.");
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // Select supported mimeType
      let mimeType = "audio/webm";
      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        mimeType = "audio/webm;codecs=opus";
      } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
        mimeType = "audio/mp4";
      } else if (MediaRecorder.isTypeSupported("audio/ogg")) {
        mimeType = "audio/ogg";
      }

      const recorder = new MediaRecorder(stream, { mimeType });
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

        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
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
          const extension = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
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

      // Voice Activity Detection (VAD): auto-submits on 1.4s silence after user speaks
      if (autoSilenceStop) {
        try {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (AudioContextClass) {
            const audioCtx = new AudioContextClass();
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

              // RMS threshold for human speech vs background noise
              if (rms > 0.025) {
                hasSpoken = true;
                silenceStartTime = null;
              } else if (hasSpoken) {
                if (silenceStartTime === null) {
                  silenceStartTime = Date.now();
                } else if (Date.now() - silenceStartTime >= 1400) {
                  // 1.4s of silence detected after speaking -> auto-submit!
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
