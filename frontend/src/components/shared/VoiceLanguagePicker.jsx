import { Languages } from "lucide-react";
import LanguageDropdown from "./LanguageDropdown";

// Compact voice-language picker used next to the mic button in Studio and
// Knowledge Hub. Keyed by BCP-47 speechCode (what SpeechRecognition.lang
// expects), separate from the site-wide uiCode picker in Settings.
export default function VoiceLanguagePicker({ value, onChange, className = "" }) {
  return (
    <LanguageDropdown
      value={value}
      onChange={onChange}
      getCode={(lang) => lang.speechCode}
      align="right"
      className={className}
      trigger={
        <>
          <Languages size={14} />
          <span className="uppercase">{value.split("-")[0]}</span>
        </>
      }
    />
  );
}
