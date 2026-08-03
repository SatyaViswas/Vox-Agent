import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { GUEST_USER_ID, normalizeUserId } from "../lib/auth";

const STORAGE_KEY = "voxagent_user_id";
const GUEST_ID = GUEST_USER_ID;

const AuthContext = createContext(null);

function readStoredUserId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const normalized = normalizeUserId(raw);
    // Heal any previously-stored non-UUID sentinel (e.g. the old "default")
    // so the API client's independent localStorage read picks it up too.
    if (raw !== normalized) localStorage.setItem(STORAGE_KEY, normalized);
    return normalized;
  } catch {
    return GUEST_ID;
  }
}

export function AuthProvider({ children }) {
  const [userId, setUserId] = useState(readStoredUserId);
  const [isAuthenticated, setIsAuthenticated] = useState(() => readStoredUserId() !== GUEST_ID);

  const persistUserId = useCallback((id) => {
    setUserId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // localStorage unavailable (e.g. private mode) — fall back to in-memory session only
    }
  }, []);

  const startGuestSession = useCallback(() => {
    persistUserId(GUEST_ID);
    setIsAuthenticated(false);
  }, [persistUserId]);

  const switchSession = useCallback(
    (id) => {
      if (!id) return;
      persistUserId(id);
      setIsAuthenticated(id !== GUEST_ID);
    },
    [persistUserId]
  );

  const signOut = useCallback(() => {
    persistUserId(GUEST_ID);
    setIsAuthenticated(false);
  }, [persistUserId]);

  const value = useMemo(
    () => ({
      userId,
      isGuest: userId === GUEST_ID,
      isAuthenticated,
      startGuestSession,
      switchSession,
      signOut,
    }),
    [userId, isAuthenticated, startGuestSession, switchSession, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
