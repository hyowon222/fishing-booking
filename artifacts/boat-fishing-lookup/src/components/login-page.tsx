import { useState } from 'react';
import { Anchor, LoaderCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth';

export default function LoginPage() {
  const { login, configured } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const err = await login(username.trim(), password);
    if (err) setError(err);
    setBusy(false);
  };

  const input = 'h-12 w-full rounded-lg border border-input bg-background px-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15';
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10" data-testid="login-page">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_8px_22px_hsl(166_66%_47%_/_0.25)]">
            <Anchor size={28} strokeWidth={2.3} />
          </div>
          <h1 className="font-serif text-2xl font-bold tracking-tight">바다자리</h1>
          <p className="mt-1 text-sm text-muted-foreground">로그인해서 이용해 주세요</p>
        </div>
        <form onSubmit={submit} className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-[0_14px_45px_hsl(214_42%_18%_/_0.08)]">
          <div>
            <label htmlFor="login-id" className="mb-1.5 block text-xs font-semibold text-muted-foreground">아이디</label>
            <input
              id="login-id"
              className={input}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              data-testid="input-login-id"
            />
          </div>
          <div>
            <label htmlFor="login-pw" className="mb-1.5 block text-xs font-semibold text-muted-foreground">비밀번호</label>
            <input
              id="login-pw"
              type="password"
              className={input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              data-testid="input-login-password"
            />
          </div>
          {error && <p className="text-sm text-destructive" role="alert" data-testid="login-error">{error}</p>}
          {!configured && <p className="text-xs text-destructive">서버에 관리자 계정이 아직 설정되지 않았어요.</p>}
          <button
            type="submit"
            disabled={busy || !username.trim() || !password}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary text-base font-bold text-primary-foreground transition disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="button-login"
          >
            {busy && <LoaderCircle size={18} className="animate-spin" />}
            로그인
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-muted-foreground">계정은 관리자가 발급해 드려요. 계정이 필요하면 관리자에게 문의하세요.</p>
      </div>
    </div>
  );
}
