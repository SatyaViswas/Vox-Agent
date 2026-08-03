import { useCallback, useEffect, useRef, useState } from "react";

const SpeechRecognitionImpl =
  typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export function useSpeechRecognition({ onFinalTranscript } = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;

  const isSupported = Boolean(SpeechRecognitionImpl);

  useEffect(() => {
    if (!isSupported) return;
    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
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
      setError(event.error || "speech-recognition-error");
      setIsRecording(false);
    };

    recognition.onend = () => {
      setIsRecording(false);
      setInterimTranscript("");
    };

    recognitionRef.current = recognition;
    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // already stopped
      }
    };
  }, [isSupported]);

  const start = useCallback(() => {
    if (!recognitionRef.current || isRecording) return;
    setError(null);
    try {
      recognitionRef.current.start();
      setIsRecording(true);
    } catch {
      // recognition already active
    }
  }, [isRecording]);

  const stop = useCallback(() => {
    if (!recognitionRef.current) return;
    recognitionRef.current.stop();
  }, []);

  const toggle = useCallback(() => {
    if (isRecording) stop();
    else start();
  }, [isRecording, start, stop]);

  return { isSupported, isRecording, interimTranscript, error, start, stop, toggle };
}
