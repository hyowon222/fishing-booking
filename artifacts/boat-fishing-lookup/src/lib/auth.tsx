import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type AuthUser = { username: string; isAdmin: boolean; canBook: boolean };
type AuthState = {
  user: AuthUser | null;
  configured: boolean;
  login: (username: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
};

// 어느 요청이든 서버가 "로그인 필요(401)"라고 하면 로그인 화면으로 돌려보낸다
const EXPIRED = 'badajari:auth-expired';
if (typeof window !== 'undefined' && !(window as unknown as { __authFetch?: boolean }).__authFetch) {
  (window as unknown as { __authFetch?: boolean }).__authFetch = true;
  const original = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await original(...args);
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) window.dispatchEvent(new Event(EXPIRED));
    return res;
  };
}

const Ctx = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider 안에서만 사용할 수 있습니다');
  return v;
}

export function AuthProvider({ children, loading, onLoggedOut }: { children: ReactNode; loading: ReactNode; onLoggedOut?: () => void }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [configured, setConfigured] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((b) => {
        if (!alive) return;
        setUser(b.user ?? null);
        setConfigured(b.configured !== false);
      })
      .catch(() => undefined)
      .finally(() => alive && setReady(true));
    const expired = () => {
      setUser(null);
      onLoggedOut?.();
    };
    window.addEventListener(EXPIRED, expired);
    return () => {
      alive = false;
      window.removeEventListener(EXPIRED, expired);
    };
  }, [onLoggedOut]);

  const login = useCallback(async (username: string, password: string) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return (body.error as string) ?? `로그인에 실패했어요 (${res.status})`;
      setUser(body.user);
      return null;
    } catch {
      return '서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요';
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
    onLoggedOut?.();
  }, [onLoggedOut]);

  if (!ready) return <>{loading}</>;
  return <Ctx.Provider value={{ user, configured, login, logout }}>{children}</Ctx.Provider>;
}
