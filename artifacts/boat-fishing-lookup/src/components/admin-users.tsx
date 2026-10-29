import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, KeyRound, LoaderCircle, Trash2, UserPlus } from 'lucide-react';

type U = { username: string; canBook: boolean; createdAt: string };

export default function AdminUsers({ onBack }: { onBack: () => void }) {
  const [users, setUsers] = useState<U[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [canBook, setCanBook] = useState(false);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/users${path}`, { ...init, headers: { 'content-type': 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `오류 (${res.status})`);
      setUsers(body.users);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void call('');
  }, [call]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await call('', { method: 'POST', body: JSON.stringify({ username: name.trim(), password: pw, canBook }) });
    if (ok) {
      setName('');
      setPw('');
      setCanBook(false);
    }
  };
  const resetPw = async (u: U) => {
    const next = window.prompt(`${u.username} 의 새 비밀번호 (6자 이상)`);
    if (next) await call(`/${encodeURIComponent(u.username)}`, { method: 'PATCH', body: JSON.stringify({ password: next }) });
  };
  const remove = async (u: U) => {
    if (window.confirm(`${u.username} 계정을 삭제할까요?`)) await call(`/${encodeURIComponent(u.username)}`, { method: 'DELETE' });
  };

  const input = 'h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15';
  return (
    <main className="mx-auto max-w-2xl space-y-5 px-4 pb-12 pt-5 sm:px-6" data-testid="admin-users">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="rounded-lg p-1.5 hover:bg-muted" aria-label="뒤로"><ArrowLeft size={18} /></button>
        <h2 className="text-lg font-bold">계정 관리</h2>
        {busy && <LoaderCircle size={16} className="animate-spin text-muted-foreground" />}
      </div>
      <p className="text-xs text-muted-foreground">
        여기서 발급한 계정으로만 로그인할 수 있어요. 기본은 조회·물때만 쓸 수 있고, “자동 예약·예약처” 권한을 켠 계정만 그 메뉴를 쓸 수 있어요. 관리자 계정은 서버 설정(환경변수)에서 바꿔요.
      </p>

      <form onSubmit={add} className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-bold"><UserPlus size={16} />새 계정 발급</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={input} placeholder="아이디" value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="none" autoComplete="off" data-testid="input-new-user" />
          <input className={input} placeholder="비밀번호 (6자 이상)" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" data-testid="input-new-password" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={canBook} onChange={(e) => setCanBook(e.target.checked)} />
          자동 예약·예약처 메뉴 권한 주기
        </label>
        <button type="submit" disabled={busy || !name.trim() || pw.length < 6} className="h-11 rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-50" data-testid="button-add-user">
          계정 만들기
        </button>
      </form>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      <div className="space-y-2">
        <div className="text-sm font-bold">발급된 계정 {users ? `(${users.length})` : ''}</div>
        {users && users.length === 0 && <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">아직 발급한 계정이 없어요</p>}
        {users?.map((u) => (
          <div key={u.username} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card p-3" data-testid={`user-row-${u.username}`}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{u.username}</div>
              <div className="text-[11px] text-muted-foreground">{new Date(u.createdAt).toLocaleDateString('ko-KR')} 발급</div>
            </div>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={u.canBook}
                onChange={(e) => call(`/${encodeURIComponent(u.username)}`, { method: 'PATCH', body: JSON.stringify({ canBook: e.target.checked }) })}
                data-testid={`perm-${u.username}`}
              />
              자동 예약·예약처 권한
            </label>
            <button type="button" onClick={() => resetPw(u)} className="rounded-lg border p-2" aria-label="비밀번호 변경" title="비밀번호 변경"><KeyRound size={15} /></button>
            <button type="button" onClick={() => remove(u)} className="rounded-lg border p-2 text-destructive" aria-label="삭제" title="삭제"><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
    </main>
  );
}
