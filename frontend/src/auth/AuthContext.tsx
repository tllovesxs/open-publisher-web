import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: "user" | "admin" | string;
}

interface LoginPayload {
  token: string;
  user: AuthUser;
}

const TOKEN_KEY = "opw_access_token";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string, admin?: boolean) => Promise<AuthUser>;
  register: (username: string, password: string, displayName: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  updateProfile: (displayName: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function storeSession(payload: LoginPayload) {
  localStorage.setItem(TOKEN_KEY, payload.token);
  localStorage.setItem("opw_user_id", payload.user.id);
  return payload.user;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      localStorage.removeItem("opw_user_id");
      setLoading(false);
      return;
    }
    api
      .get<AuthUser>("/auth/me")
      .then((res) => { localStorage.setItem("opw_user_id", res.data.id); setUser(res.data); })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem("opw_user_id");
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string, admin = false) => {
    const res = await api.post<LoginPayload>(admin ? "/auth/admin/login" : "/auth/login", { username, password });
    const nextUser = storeSession(res.data);
    setUser(nextUser);
    return nextUser;
  }, []);

  const register = useCallback(async (username: string, password: string, displayName: string) => {
    const res = await api.post<LoginPayload>("/auth/register", { username, password, displayName });
    const nextUser = storeSession(res.data);
    setUser(nextUser);
    return nextUser;
  }, []);

  const updateProfile = useCallback(async (displayName: string) => {
    const res = await api.patch<AuthUser>("/auth/me", { displayName });
    setUser(res.data);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem("opw_user_id");
      setUser(null);
    }
  }, []);

  const value = useMemo(() => ({ user, loading, login, register, logout, updateProfile }), [user, loading, login, register, logout, updateProfile]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth 必须在 AuthProvider 中使用");
  return context;
}
