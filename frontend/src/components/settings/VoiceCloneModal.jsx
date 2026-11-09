import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Mic,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import { useSettings } from "../../context/SettingsContext";
import { extractVoiceEmbedding, synthesizeClonedVoice } from "../../api/voice";

const CALIBRATION_SCRIPTS = [
  {
    id: "en",
    lang: "English",
    label: "Professional Automation Script",
    text: "I authorize VoxAgent to assist me with my daily workflows and automation. Let's build autonomous agents together.",
  },
  {
    id: "te",
    lang: "Telugu",
    label: "తెలుగు స్క్రిప్ట్",
    text: "నా రోజువారీ పనులు మరియు ఆటోమేషన్‌లో సహాయం చేయడానికి నేను VoxAgent కు అనుమతి ఇస్తున్నాను. కలిసి కొత్త ఏజెంట్లను తయారు చేద్దాం.",
  },
  {
    id: "hi",
    lang: "Hindi / Hinglish",
    label: "हिंदी / हिंग्लिश स्क्रिप्ट",
    text: "मैं वोक्स एजेंट को अपने सभी दैनिक कार्यों और ऑटोमेशन में सहायता करने के लिए अधिकृत करता हूँ। आइए मिलकर नए एजेंट्स बनाएं।",
  },
  {
    id: "ta",
    lang: "Tamil",
    label: "தமிழ் ஸ்கிரிப்ட்",
    text: "வோக்స్ ஏஜென்ட் எனது தினசரி தானியங்கி பணிகளில் உதவ நான் அங்கீகரிக்கிறேன். புதிய முகவர்களை உருவாக்குவோம்.",
  },
];

export default function VoiceCloneModal({ isOpen, onClose }) {
  const { t } = useTranslation();
  const { saveClonedVoice, clonedVoice } = useSettings();

  const [step, setStep] = useState("record"); // record | review | extracting | test | success
  const [selectedScriptId, setSelectedScriptId] = useState("en");
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);

  const [recordedBlob, setRecordedBlob] = useState(null);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState(null);

  const [extractError, setExtractError] = useState(null);
  const [extractedEmbedding, setExtractedEmbedding] = useState(null);

  const [testAudioUrl, setTestAudioUrl] = useState(null);
  const [isTestingVoice, setIsTestingVoice] = useState(false);
  const [isPlayingTest, setIsPlayingTest] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const testAudioRef = useRef(null);
  const previewAudioRef = useRef(null);

  const activeScript = CALIBRATION_SCRIPTS.find((s) => s.id === selectedScriptId) || CALIBRATION_SCRIPTS[0];

  // Reset state when opening/closing
  useEffect(() => {
    if (!isOpen) {
      cleanupMedia();
      setStep("record");
      setIsRecording(false);
      setRecordingSeconds(0);
      setAudioLevel(0);
      setRecordedBlob(null);
      setRecordedAudioUrl(null);
      setExtractError(null);
      setExtractedEmbedding(null);
      setTestAudioUrl(null);
      setIsTestingVoice(false);
      setIsPlayingTest(false);
    }
  }, [isOpen]);

  const cleanupMedia = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (testAudioRef.current) {
      testAudioRef.current.pause();
      testAudioRef.current = null;
    }
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }
  };

  if (!isOpen) return null;

  // 1. Start Recording Voice Sample
  const handleStartRecording = async () => {
    cleanupMedia();
    setExtractError(null);
    audioChunksRef.current = [];
    setRecordingSeconds(0);

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

      // Audio level analyser for visualizer
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContextClass();
        audioContextRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const updateLevel = () => {
          if (!analyserRef.current) return;
          analyserRef.current.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const avg = sum / dataArray.length;
          setAudioLevel(Math.min(100, Math.round((avg / 128) * 100)));
          animFrameRef.current = requestAnimationFrame(updateLevel);
        };
        updateLevel();
      } catch (e) {
        console.warn("AudioContext meter initialization skipped:", e);
      }

      // Recorder MIME check
      let mimeType = "audio/webm";
      if (typeof MediaRecorder !== "undefined") {
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
          mimeType = "audio/webm;codecs=opus";
        } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
          mimeType = "audio/mp4";
        } else if (MediaRecorder.isTypeSupported("audio/ogg")) {
          mimeType = "audio/ogg";
        }
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        setRecordedBlob(blob);
        const url = URL.createObjectURL(blob);
        setRecordedAudioUrl(url);
        setStep("review");
        setIsRecording(false);
      };

      recorder.start(250);
      setIsRecording(true);

      timerIntervalRef.current = setInterval(() => {
        setRecordingSeconds((prev) => {
          if (prev >= 20) {
            handleStopRecording();
            return 20;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (err) {
      console.error("Microphone access error:", err);
      setExtractError(
        "Microphone access denied. Please grant microphone permissions in your browser to record your voice."
      );
    }
  };

  // 2. Stop Recording
  const handleStopRecording = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  // 3. Extract Neural Speaker Embedding
  const handleExtractEmbedding = async () => {
    if (!recordedBlob) return;
    setStep("extracting");
    setExtractError(null);

    try {
      let ext = "wav";
      const blobType = (recordedBlob.type || "").toLowerCase();
      if (blobType.includes("webm")) ext = "webm";
      else if (blobType.includes("mp4") || blobType.includes("m4a")) ext = "m4a";
      else if (blobType.includes("ogg")) ext = "ogg";

      const filename = `voice_calibration_sample.${ext}`;
      const res = await extractVoiceEmbedding(recordedBlob, filename);

      const embeddingObj = res?.voice_clone_embedding || res?.data?.voice_clone_embedding || res;
      if (!embeddingObj || (!embeddingObj.embedding && !res.embedding)) {
        throw new Error("Invalid embedding structure returned from Gnani Voice Cloning service.");
      }

      const finalEmbedding = embeddingObj.embedding ? embeddingObj : res;
      setExtractedEmbedding(finalEmbedding);

      // Immediately run test synthesis
      setStep("test");
      await handleTestClonedVoice(finalEmbedding);
    } catch (err) {
      console.error("Voice clone embedding extraction failed:", err);
      setExtractError(
        err.message || "Failed to extract voice clone embedding. Please ensure you spoke clearly for at least 6 seconds."
      );
      setStep("review");
    }
  };

  // 4. Test Cloned Voice Synthesis
  const handleTestClonedVoice = async (embeddingToTest = extractedEmbedding) => {
    if (!embeddingToTest) return;
    setIsTestingVoice(true);
    setExtractError(null);

    try {
      const testPhrase = "Hello! Your sovereign voice clone is ready. I will now speak with your voice across VoxAgent.";
      const res = await synthesizeClonedVoice({
        text: testPhrase,
        speaker_embedding: embeddingToTest,
        language: "hi-IN",
      });

      if (res?.audioUrl) {
        setTestAudioUrl(res.audioUrl);
        const audio = new Audio(res.audioUrl);
        testAudioRef.current = audio;
        setIsPlayingTest(true);

        audio.onended = () => setIsPlayingTest(false);
        audio.onerror = () => setIsPlayingTest(false);
        await audio.play();
      }
    } catch (err) {
      console.error("Cloned voice test synthesis failed:", err);
      setExtractError("Cloned voice synthesized with warning: " + (err.message || "Service unavailable"));
    } finally {
      setIsTestingVoice(false);
    }
  };

  // 5. Save & Activate Clone
  const handleSaveAndActivate = () => {
    if (!extractedEmbedding) return;
    saveClonedVoice({
      name: "My Cloned Voice",
      sampleDuration: recordingSeconds || 10,
      createdAt: new Date().toISOString(),
      embedding: extractedEmbedding,
    });
    setStep("success");
    setTimeout(() => {
      onClose();
    }, 1800);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center p-0 sm:p-4 animate-fade-in">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onClick={onClose} />

      {/* Modal / Sheet Container */}
      <div className="relative w-full sm:max-w-xl rounded-t-[2rem] sm:rounded-3xl bg-white dark:bg-slate-900 border-t sm:border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white shadow-2xl z-10 flex flex-col max-h-[92vh] overflow-hidden pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:pb-0 animate-slide-up">
        {/* Mobile Pull Handle */}
        <div className="sm:hidden pt-3 pb-1 flex justify-center cursor-pointer" onClick={onClose}>
          <div className="w-12 h-1.5 rounded-full bg-slate-300 dark:bg-white/20" />
        </div>

        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-white/10 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white flex items-center justify-center shadow-md shadow-brand-500/20">
              <Sparkles size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-base tracking-tight">{t("voiceClone.modalTitle")}</h2>
                <span className="px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400 text-[10px] font-bold">
                  Gnani VC v1
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {t("settings.voiceCloneSubtitle")}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 transition-all"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Error Banner if any */}
          {extractError && (
            <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-start gap-2.5 animate-shake">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{extractError}</span>
            </div>
          )}

          {/* STEP 1: RECORD VOICE SAMPLE */}
          {step === "record" && (
            <div className="space-y-4">
              {/* Script Language Tabs */}
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
                  {t("voiceClone.selectScript")}
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {CALIBRATION_SCRIPTS.map((script) => (
                    <button
                      key={script.id}
                      type="button"
                      onClick={() => setSelectedScriptId(script.id)}
                      className={`px-3 py-2 rounded-xl text-xs font-semibold text-center transition-all ${
                        selectedScriptId === script.id
                          ? "bg-brand-500 text-white shadow-sm shadow-brand-500/25"
                          : "bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                      }`}
                    >
                      {script.lang}
                    </button>
                  ))}
                </div>
              </div>

              {/* Teleprompter Box */}
              <div className="p-4 rounded-2xl bg-gradient-to-br from-brand-500/5 via-fuchsia-500/5 to-transparent border border-brand-500/20 text-center relative overflow-hidden">
                <span className="text-[10px] uppercase font-bold text-brand-500 tracking-wider">
                  {t("voiceClone.readPrompt")}
                </span>
                <p className="mt-2 text-sm sm:text-base font-medium text-slate-800 dark:text-slate-100 leading-relaxed italic">
                  "{activeScript.text}"
                </p>
              </div>

              {/* Duration Guidelines & Gauge */}
              <div className="flex items-center justify-between text-xs px-1">
                <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                  <Activity size={14} className={isRecording ? "text-emerald-500 animate-pulse" : "text-slate-400"} />
                  {isRecording ? t("voiceClone.listeningState") : t("voiceClone.targetGauge")}
                </span>
                <span
                  className={`font-mono font-bold ${
                    recordingSeconds >= 6 ? "text-emerald-500" : isRecording ? "text-amber-500" : "text-slate-400"
                  }`}
                >
                  00:{recordingSeconds.toString().padStart(2, "0")} / 00:15
                </span>
              </div>

              {/* Progress Bar */}
              <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    recordingSeconds >= 6
                      ? "bg-gradient-to-r from-emerald-500 to-brand-500"
                      : "bg-gradient-to-r from-amber-400 to-amber-500"
                  }`}
                  style={{ width: `${Math.min(100, (recordingSeconds / 15) * 100)}%` }}
                />
              </div>

              {/* Audio Wave Visualizer while recording */}
              {isRecording && (
                <div className="flex items-center justify-center gap-1.5 h-10 py-1">
                  {[...Array(16)].map((_, i) => {
                    const heightPct = Math.max(15, Math.min(100, audioLevel * (0.4 + (i % 5) * 0.15)));
                    return (
                      <div
                        key={i}
                        className="w-1.5 bg-gradient-to-t from-brand-500 to-fuchsia-400 rounded-full transition-all duration-75"
                        style={{ height: `${heightPct}%` }}
                      />
                    );
                  })}
                </div>
              )}

              {/* Big Record Button */}
              <div className="pt-2 flex flex-col items-center">
                {!isRecording ? (
                  <button
                    type="button"
                    onClick={handleStartRecording}
                    className="w-20 h-20 rounded-full bg-gradient-to-tr from-brand-500 to-fuchsia-500 text-white flex items-center justify-center shadow-lg shadow-brand-500/30 hover:scale-105 active:scale-95 transition-all cursor-pointer group"
                  >
                    <Mic size={32} className="group-hover:scale-110 transition-transform" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleStopRecording}
                    disabled={recordingSeconds < 4}
                    className={`w-20 h-20 rounded-full text-white flex items-center justify-center shadow-lg transition-all cursor-pointer ${
                      recordingSeconds >= 4
                        ? "bg-rose-500 hover:bg-rose-600 shadow-rose-500/30 animate-pulse active:scale-95"
                        : "bg-slate-400 cursor-not-allowed opacity-80"
                    }`}
                  >
                    <Square size={26} className="fill-current" />
                  </button>
                )}
                <span className="text-xs font-semibold mt-3 text-slate-600 dark:text-slate-400">
                  {isRecording
                    ? recordingSeconds < 4
                      ? t("voiceClone.keepSpeaking", { count: 4 - recordingSeconds })
                      : t("voiceClone.tapToFinish")
                    : t("voiceClone.tapToRecord")}
                </span>
              </div>
            </div>
          )}

          {/* STEP 2: REVIEW RECORDED SAMPLE */}
          {step === "review" && (
            <div className="space-y-5 animate-fade-in text-center py-2">
              <div className="w-16 h-16 rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center mx-auto shadow-inner">
                <Volume2 size={32} />
              </div>

              <div>
                <h3 className="font-bold text-base text-slate-900 dark:text-white">
                  {t("voiceClone.sampleSuccess")}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  {t("voiceClone.sampleDuration", { seconds: recordingSeconds })}
                </p>
              </div>

              {/* Audio Playback Element */}
              {recordedAudioUrl && (
                <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center">
                  <audio ref={previewAudioRef} src={recordedAudioUrl} controls className="w-full h-10 rounded-lg" />
                </div>
              )}

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    cleanupMedia();
                    setStep("record");
                  }}
                  className="px-4 py-3 rounded-2xl border border-slate-300 dark:border-white/10 text-slate-700 dark:text-slate-200 font-semibold text-xs flex items-center justify-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 active:scale-95 transition-all"
                >
                  <RotateCcw size={15} />
                  <span>{t("settings.rerecord")}</span>
                </button>

                <button
                  type="button"
                  onClick={handleExtractEmbedding}
                  className="px-4 py-3 rounded-2xl bg-gradient-to-r from-brand-500 to-fuchsia-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-brand-500/25 hover:opacity-95 active:scale-95 transition-all"
                >
                  <Sparkles size={15} />
                  <span>{t("voiceClone.activateVoice")}</span>
                </button>
              </div>
            </div>
          )}

          {/* STEP 3: EXTRACTING NEURAL EMBEDDING */}
          {step === "extracting" && (
            <div className="py-12 text-center space-y-4 animate-fade-in">
              <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
                <div className="absolute inset-0 rounded-full border-4 border-brand-500/20 border-t-brand-500 animate-spin" />
                <Sparkles size={32} className="text-brand-500 animate-pulse" />
              </div>
              <div>
                <h3 className="font-bold text-base text-slate-900 dark:text-white">
                  {t("voiceClone.extracting")}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                  {t("voiceClone.extractingDesc")}
                </p>
              </div>
            </div>
          )}

          {/* STEP 4: TEST & CONFIRM CLONED VOICE */}
          {step === "test" && (
            <div className="space-y-5 animate-fade-in py-2">
              <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500 text-white flex items-center justify-center shrink-0">
                  <CheckCircle2 size={20} />
                </div>
                <div>
                  <h4 className="font-bold text-xs text-emerald-800 dark:text-emerald-300">
                    {t("voiceClone.cloneReady")}
                  </h4>
                  <p className="text-[11px] text-emerald-700/80 dark:text-emerald-400 mt-0.5">
                    Tensor shape: [1, 768] (torch.bfloat16) registered with model vachana-vc-v1.
                  </p>
                </div>
              </div>

              {/* Preview Audio Play Box */}
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-center space-y-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {t("voiceClone.testSample")}
                </span>
                <p className="text-xs italic text-slate-700 dark:text-slate-300">
                  "{t("spoken.samplePreviewClone")}"
                </p>

                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    onClick={() => handleTestClonedVoice()}
                    disabled={isTestingVoice}
                    className="px-4 py-2.5 rounded-xl bg-brand-500 text-white text-xs font-bold flex items-center gap-2 hover:bg-brand-600 active:scale-95 transition-all shadow-md shadow-brand-500/25"
                  >
                    {isTestingVoice ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : isPlayingTest ? (
                      <Square size={14} className="fill-current" />
                    ) : (
                      <Play size={14} className="fill-current" />
                    )}
                    <span>{isPlayingTest ? "Playing Cloned Voice..." : "Replay Sample"}</span>
                  </button>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    cleanupMedia();
                    setStep("record");
                  }}
                  className="px-4 py-3 rounded-2xl border border-slate-300 dark:border-white/10 text-slate-700 dark:text-slate-200 font-semibold text-xs flex items-center justify-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 active:scale-95 transition-all"
                >
                  <RotateCcw size={15} />
                  <span>{t("voiceClone.discardRetry")}</span>
                </button>

                <button
                  type="button"
                  onClick={handleSaveAndActivate}
                  className="px-4 py-3 rounded-2xl bg-gradient-to-r from-emerald-500 to-brand-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 hover:opacity-95 active:scale-95 transition-all"
                >
                  <Check size={16} />
                  <span>{t("voiceClone.activateVoice")}</span>
                </button>
              </div>
            </div>
          )}

          {/* STEP 5: SUCCESS TOAST */}
          {step === "success" && (
            <div className="py-10 text-center space-y-3 animate-scale-up">
              <div className="w-16 h-16 rounded-full bg-emerald-500 text-white flex items-center justify-center mx-auto shadow-lg shadow-emerald-500/30">
                <Check size={32} />
              </div>
              <h3 className="font-bold text-base text-slate-900 dark:text-white">{t("voiceClone.updatedTitle")}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs mx-auto">
                {t("voiceClone.updatedDesc")}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

