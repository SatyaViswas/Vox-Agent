import { createContext, useContext, useEffect, useState } from "react";

const SettingsContext = createContext(null);

const STORAGE_KEY_VOICE = "voxagent_tts_voice";
const STORAGE_KEY_TTS_ENABLED = "voxagent_tts_enabled";
const STORAGE_KEY_HAPTICS = "voxagent_haptics";
const STORAGE_KEY_AUTO_HEAL = "voxagent_auto_heal";
const STORAGE_KEY_CONFIRM_HIGH_RISK = "voxagent_confirm_high_risk";
const STORAGE_KEY_CLONED_VOICE = "voxagent_cloned_voice";

export function SettingsProvider({ children }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("general"); // general | voice | account | safety

  // Voice Persona (Timbre or Custom Cloned Voice)
  const [ttsVoice, setTtsVoiceState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_VOICE) || "Shivani";
    } catch {
      return "Shivani";
    }
  });

  // User's Sovereign Cloned Voice Profile
  const [clonedVoice, setClonedVoiceState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_CLONED_VOICE);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const [ttsEnabled, setTtsEnabledState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_TTS_ENABLED);
      return stored !== null ? stored === "true" : true;
    } catch {
      return true;
    }
  });

  // Haptics on mobile touch
  const [hapticsEnabled, setHapticsEnabledState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_HAPTICS);
      return stored !== null ? stored === "true" : true;
    } catch {
      return true;
    }
  });

  // Safety options
  const [autoHeal, setAutoHealState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_AUTO_HEAL);
      return stored !== null ? stored === "true" : true;
    } catch {
      return true;
    }
  });

  const [confirmHighRisk, setConfirmHighRiskState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_CONFIRM_HIGH_RISK);
      return stored !== null ? stored === "true" : true;
    } catch {
      return true;
    }
  });

  const setTtsVoice = (name) => {
    setTtsVoiceState(name);
    try {
      localStorage.setItem(STORAGE_KEY_VOICE, name);
      window.dispatchEvent(new Event("voxagent_voice_changed"));
    } catch {}
  };

  const setTtsEnabled = (enabled) => {
    setTtsEnabledState(enabled);
    try {
      localStorage.setItem(STORAGE_KEY_TTS_ENABLED, String(enabled));
      window.dispatchEvent(new Event("voxagent_voice_changed"));
    } catch {}
  };

  const setHapticsEnabled = (enabled) => {
    setHapticsEnabledState(enabled);
    try {
      localStorage.setItem(STORAGE_KEY_HAPTICS, String(enabled));
    } catch {}
  };

  const setAutoHeal = (val) => {
    setAutoHealState(val);
    try {
      localStorage.setItem(STORAGE_KEY_AUTO_HEAL, String(val));
    } catch {}
  };

  const setConfirmHighRisk = (val) => {
    setConfirmHighRiskState(val);
    try {
      localStorage.setItem(STORAGE_KEY_CONFIRM_HIGH_RISK, String(val));
    } catch {}
  };

  const saveClonedVoice = (voiceData) => {
    setClonedVoiceState(voiceData);
    try {
      localStorage.setItem(STORAGE_KEY_CLONED_VOICE, JSON.stringify(voiceData));
      setTtsVoice("custom-clone");
      window.dispatchEvent(new Event("voxagent_voice_changed"));
    } catch (e) {
      console.error("Failed to save cloned voice:", e);
    }
  };

  const deleteClonedVoice = () => {
    setClonedVoiceState(null);
    try {
      localStorage.removeItem(STORAGE_KEY_CLONED_VOICE);
      if (ttsVoice === "custom-clone") {
        setTtsVoice("Shivani");
      }
      window.dispatchEvent(new Event("voxagent_voice_changed"));
    } catch (e) {
      console.error("Failed to delete cloned voice:", e);
    }
  };

  const openSettings = (tab = "general") => {
    setActiveTab(tab);
    setIsOpen(true);
  };

  const closeSettings = () => {
    setIsOpen(false);
  };

  return (
    <SettingsContext.Provider
      value={{
        isOpen,
        activeTab,
        setActiveTab,
        openSettings,
        closeSettings,
        ttsVoice,
        setTtsVoice,
        ttsEnabled,
        setTtsEnabled,
        clonedVoice,
        saveClonedVoice,
        deleteClonedVoice,
        hapticsEnabled,
        setHapticsEnabled,
        autoHeal,
        setAutoHeal,
        confirmHighRisk,
        setConfirmHighRisk,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return context;
}
