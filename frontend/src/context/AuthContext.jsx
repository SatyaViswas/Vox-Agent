import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { GUEST_USER_ID, normalizeUserId } from "../lib/auth";
import { supabase } from "../lib/supabase";

const STORAGE_KEY = "voxagent_user_id";
const GUEST_ID = GUEST_USER_ID;

const AuthContext = createContext(null);

function readStoredUserId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const normalized = normalizeUserId(raw);
    if (raw !== normalized) localStorage.setItem(STORAGE_KEY, normalized);
    return normalized;
  } catch {
    return GUEST_ID;
  }
}

export function AuthProvider({ children }) {
  const [userId, setUserId] = useState(readStoredUserId);
  const [isAuthenticated, setIsAuthenticated] = useState(() => readStoredUserId() !== GUEST_ID);
  const [sessionUser, setSessionUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const persistUserId = useCallback((id) => {
    setUserId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // localStorage unavailable
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      if (session?.user) {
        setSessionUser(session.user);
        persistUserId(session.user.id);
        setIsAuthenticated(true);
      } else {
        const stored = readStoredUserId();
        if (stored !== GUEST_ID) {
          persistUserId(GUEST_ID);
          setIsAuthenticated(false);
        }
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setSessionUser(session.user);
        persistUserId(session.user.id);
        setIsAuthenticated(true);
      } else {
        setSessionUser(null);
        persistUserId(GUEST_ID);
        setIsAuthenticated(false);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [persistUserId]);

  const startGuestSession = useCallback(() => {
    persistUserId(GUEST_ID);
    setIsAuthenticated(false);
  }, [persistUserId]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    persistUserId(GUEST_ID);
    setIsAuthenticated(false);
    setSessionUser(null);
  }, [persistUserId]);

  const value = useMemo(
    () => ({
      userId,
      user: sessionUser,
      isGuest: userId === GUEST_ID,
      isAuthenticated,
      startGuestSession,
      signOut,
      loading
    }),
    [userId, sessionUser, isAuthenticated, startGuestSession, signOut, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
