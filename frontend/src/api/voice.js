import { apiClient, BASE_URL } from "./client";

/**
 * Generate sub-second streaming audio URL for Gnani Timbre TTS.
 * Browser begins audio playback in <400ms without waiting for full synthesis.
 * @param {object} params
 * @param {string} params.text
 * @param {string} [params.voice="Shivani"]
 * @param {string} [params.language="hi-IN"]
 * @param {string} [params.model="timbre-v3.0"]
 * @param {number} [params.speed=1.0]
 * @param {string} [params.container="mp3"]
 * @returns {string} Streaming endpoint URL
 */
export function getStreamingSpeechUrl({
  text,
  voice = "Shivani",
  language = "hi-IN",
  model = "timbre-v3.0",
  speed = 1.05,
  container = "mp3",
}) {
  const base = BASE_URL.startsWith("http")
    ? BASE_URL
    : (typeof window !== "undefined" ? window.location.origin : "") + BASE_URL;
  const params = new URLSearchParams({
    text: text.trim(),
    voice,
    language,
    model,
    speed: String(speed),
    container,
  });
  return `${base}/tts/stream?${params.toString()}`;
}

/**
 * Returns audio streaming object with instant URL.
 */
export async function streamSpeech(params) {
  const audioUrl = getStreamingSpeechUrl(params);
  return { audioUrl };
}

/**
 * Transcribe an audio recording using Gnani Prisma v3.0 (with Auto-LID, code-mix, and context boosting).
 * @param {Blob} audioBlob - Audio recorded from MediaRecorder
 * @param {string} [filename="recording.wav"] - Filename
 * @param {object} [options={}] - Options (languageCode, formatStyle)
 * @returns {Promise<{transcript: string, detected_language_code: string, model: string, user_entities_boosted: number, keyterms_applied: string[], topic: string}>}
 */
export async function transcribeAudio(audioBlob, filename = "recording.wav", options = {}) {
  const formData = new FormData();
  formData.append("file", audioBlob, filename);
  if (options.languageCode) formData.append("language_code", options.languageCode);
  if (options.formatStyle) formData.append("format_style", options.formatStyle);

  return apiClient.post("/transcribe", formData);
}

/**
 * Synthesize speech from text using Gnani Timbre v3.0 with optional inline audio tags.
 * @param {object} params
 * @param {string} params.text - Text with optional audio tags (<excited>, <pauses>, etc.)
 * @param {string} [params.voice="Shivani"] - Timbre voice name
 * @param {string} [params.language="hi-IN"] - Indic language code
 * @param {string} [params.model="timbre-v3.0"] - Model name
 * @param {number} [params.speed=1.0] - Speed between 0.85 and 1.15
 * @param {string} [params.container="wav"] - "wav" or "mp3"
 * @returns {Promise<{blob: Blob, audioUrl: string}>}
 */
export async function synthesizeSpeech({
  text,
  voice = "Shivani",
  language = "hi-IN",
  model = "timbre-v3.0",
  speed = 1.05,
  container = "mp3",
}) {
  const blob = await apiClient.post("/tts/synthesize", {
    text,
    voice,
    language,
    model,
    speed,
    container,
  });

  const audioUrl = URL.createObjectURL(blob);
  return { blob, audioUrl };
}

/**
 * Fetch the catalog of 13 Timbre v3.0 voices and available expressive audio tags.
 * @returns {Promise<{voices: Array, supported_tags: Array}>}
 */
export function getAvailableVoices() {
  return apiClient.get("/tts/voices");
}

/**
 * Extract a 768-dimensional voice clone embedding from a short reference audio clip.
 * @param {Blob} audioBlob
 * @param {string} [filename="sample.wav"]
 * @returns {Promise<{voice_clone_embedding: object}>}
 */
export async function extractVoiceEmbedding(audioBlob, filename = "sample.wav") {
  const formData = new FormData();
  formData.append("audio_file", audioBlob, filename);

  return apiClient.post("/tts/voice-clone/embeddings", formData);
}

/**
 * Synthesize speech in the user's cloned voice.
 * @param {object} params
 * @param {string} params.text
 * @param {object} params.speaker_embedding
 * @returns {Promise<{blob: Blob, audioUrl: string}>}
 */
export async function synthesizeClonedVoice({
  text,
  speaker_embedding,
  language = "hi-IN",
  sample_rate = 44100,
  container = "wav",
}) {
  const blob = await apiClient.post("/tts/voice-clone/synthesize", {
    text,
    speaker_embedding,
    language,
    sample_rate,
    container,
  });

  const audioUrl = URL.createObjectURL(blob);
  return { blob, audioUrl };
}

/**
 * Resolve a spoken disambiguation answer into blueprint parameters.
 * @param {object} params
 * @param {string} params.clarificationQuestion
 * @param {Array} params.missingParameters
 * @param {string} params.spokenAnswer
 * @param {object} [params.existingValues]
 * @returns {Promise<{success: boolean, resolved_values: object, all_resolved: boolean, spoken_acknowledgement: string}>}
 */
export async function resolveDisambiguation({
  clarificationQuestion,
  missingParameters,
  spokenAnswer,
  existingValues = {},
}) {
  return apiClient.post("/disambiguate/resolve", {
    clarification_question: clarificationQuestion,
    missing_parameters: missingParameters,
    spoken_answer: spokenAnswer,
    existing_values: existingValues,
  });
}

/**
 * Resolve spoken text into a multi-purpose assistant intent (create workflow, update blueprint, resume paused run, navigate, etc.).
 * @param {string} spokenText
 * @param {object} [context={}]
 * @returns {Promise<{
 *   intent: string,
 *   action?: string,
 *   answer?: string,
 *   prompt?: string,
 *   route?: string,
 *   agent_id?: string,
 *   agent_name?: string,
 *   resolved_values?: object,
 *   all_resolved?: boolean,
 *   spoken_acknowledgement: string,
 *   display_title: string,
 *   display_detail: string
 * }>}
 */
export async function resolveVoiceAssistantIntent(spokenText, context = {}, language = "en") {
  return apiClient.post("/voice-assistant/intent", {
    spoken_text: spokenText,
    context,
    language,
  });
}


