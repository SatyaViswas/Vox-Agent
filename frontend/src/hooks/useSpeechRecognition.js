import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const SpeechRecognitionImpl =
  typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

// Errors that mean "don't bother retrying" — mic access or the selected
// language is fundamentally unavailable, so auto-restarting would just spin
// forever with the same error.
const TERMINAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"]);

// If the browser keeps ending the session without ever producing a result
// (e.g. the selected language isn't actually supported, even though it
// didn't return a clean "language-not-supported" error), auto-restarting
// unconditionally spins in a tight loop — pinning the main thread and, on
// Chrome, eventually tripping its own rapid-restart abuse guard, which
// surfaces as a misleading "not-allowed" (looks exactly like a permission
// problem even though mic access was never the issue). Cap consecutive
// restarts-without-a-result so a genuinely unsupported language fails
// loudly and honestly instead of looping.
const MAX_RESULTLESS_RESTARTS = 3;
const RESTART_DELAY_MS = 350;

export function useSpeechRecognition({ onFinalTranscript, lang = "en-US" } = {}) {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;
  const langRef = useRef(lang);
  langRef.current = lang;

  // Distinguishes "the user clicked stop" from "the browser ended the
  // session on its own" (e.g. Chrome's silence timeout, which fires even
  // with continuous = true). Only the latter should auto-restart.
  const manualStopRef = useRef(false);
  const terminalErrorRef = useRef(false);
  const gotResultRef = useRef(false);
  const resultlessRestartsRef = useRef(0);
  const restartTimerRef = useRef(null);

  const isSupported = Boolean(SpeechRecognitionImpl);

  const startRef = useRef(null);

  const errorMessages = {
    "not-allowed": t("voice.micDenied"),
    "service-not-allowed": t("voice.serviceNotAllowed"),
    "language-not-supported": t("voice.languageNotSupported"),
    "audio-capture": t("voice.noMic"),
    network: t("voice.networkInterrupted"),
    "no-speech": undefined,
    aborted: undefined,
  };
  const errorMessagesRef = useRef(errorMessages);
  errorMessagesRef.current = errorMessages;

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (!isSupported) return;
    if (recognitionRef.current) return;
    clearRestartTimer();
    manualStopRef.current = false;
    terminalErrorRef.current = false;
    gotResultRef.current = false;
    setError(null);
    setInterimTranscript("");

    // Always create a fresh instance when starting to avoid "dead" instance bugs
    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = langRef.current;

    recognition.onresult = (event) => {
      gotResultRef.current = true;
      resultlessRestartsRef.current = 0;
      let finalChunk = "";
      let interimChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalChunk += transcript;
        else interimChunk += transcript;
      }
      if (finalChunk) {
        onFinalRef.current?.(finalChunk.trim());
        setInterimTranscript("");
      } else {
        setInterimTranscript(interimChunk);
      }
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error:", event.error);
      if (TERMINAL_ERRORS.has(event.error)) {
        terminalErrorRef.current = true;
      }
      const message = errorMessagesRef.current[event.error];
      if (message) setError(message);
    };

    recognition.onend = () => {
      recognitionRef.current = null;

      if (!gotResultRef.current) {
        resultlessRestartsRef.current += 1;
      }

      const loopedTooManyTimes = resultlessRestartsRef.current > MAX_RESULTLESS_RESTARTS;
      const shouldRestart = !manualStopRef.current && !terminalErrorRef.current && !loopedTooManyTimes;

      if (shouldRestart) {
        // Browser ended the session on its own (silence timeout, transient
        // network blip, etc.) — restart to keep voice mode feeling
        // continuous instead of requiring the user to click the mic again.
        // A short delay (rather than restarting synchronously) avoids
        // hammering the browser's speech service in a tight loop.
        restartTimerRef.current = setTimeout(() => {
          restartTimerRef.current = null;
          startRef.current?.();
        }, RESTART_DELAY_MS);
      } else {
        if (loopedTooManyTimes && !terminalErrorRef.current) {
          setError(t("voice.tooManyRestarts"));
        }
        setIsRecording(false);
        setInterimTranscript("");
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Failed to start speech recognition:", err);
      recognitionRef.current = null;
      setError(t("voice.startFailed"));
      setIsRecording(false);
    }
  }, [isSupported, clearRestartTimer, t]);

  startRef.current = start;

  const stop = useCallback(() => {
    manualStopRef.current = true;
    clearRestartTimer();
    if (!recognitionRef.current) {
      setIsRecording(false);
      return;
    }
    try {
      recognitionRef.current.stop();
    } catch {
      // ignore
    }
  }, [clearRestartTimer]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      manualStopRef.current = true;
      clearRestartTimer();
      if (recognitionRef.current) {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
    };
  }, [clearRestartTimer]);

  const toggle = useCallback(() => {
    if (isRecording) stop();
    else start();
  }, [isRecording, start, stop]);

  return { isSupported, isRecording, interimTranscript, error, start, stop, toggle };
}
