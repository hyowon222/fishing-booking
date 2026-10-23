import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, LoaderCircle, Play, Plus, Square, X } from 'lucide-react';

type BookingResult = {
  ship: { uid: string; name: string };
  species: string;
  people: number;
  seats: number[];
  seatNote: string;
  status: string;
  price: string;
  actionUrl: string;
  payload: string;
  unresolved: string[];
};
type Job = {
  id: string;
  createdAt: number;
  status: 'waiting' | 'polling' | 'done' | 'failed' | 'stopped';
  summary: string;
  log: string[];
  result?: BookingResult;
  error?: string;
};

const KNOWN_SHIPS = ['승주호', '헌터호', '골드피싱', '으리호', '블루오션', '바다호', '영스타호', '뚜기호', '유리호', '나대세호', '아산호', '박찬호', '히트호', '헤르메스호', '만석호'];
const STATUS_LABEL: Record<Job['status'], string> = { waiting: '오픈 대기', polling: '배 찾는 중', done: '입력 준비 완료', failed: '실패', stopped: '중지됨' };
const STATUS_STYLE: Record<Job['status'], string> = {
  waiting: 'bg-amber-100 text-amber-800',
  polling: 'bg-blue-100 text-blue-800',
  done: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  stopped: 'bg-muted text-muted-foreground',
};

const LS = {
  name: 'autoBooking.name',
  phone: 'autoBooking.phone',
  key: 'autoBooking.key',
  ships: 'autoBooking.ships',
};
const load = (k: string, d = '') => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 저장이 막힌 환경에서는 무시 */
  }
};

function maskPayload(p: string) {
  // 화면 표시용: 이름·전화번호 값은 가림
  return p.replace(/(BI_NAME=)[^&]*/, '$1***').replace(/(BI_TEL2=)[^&]*/, '$1****').replace(/(BI_TEL3=)[^&]*/, '$1****');
}

export default function AutoBooking({ onBack }: { onBack: () => void }) {
  const [adminKey, setAdminKey] = useState(() => load(LS.key));
  const [needKey, setNeedKey] = useState(false);
  const [relayOk, setRelayOk] = useState<boolean | null>(null);

  const [date, setDate] = useState('');
  const [ships, setShips] = useState<string[]>(() => {
    try {
      const v = JSON.parse(load(LS.ships, '[]'));
      return Array.isArray(v) && v.length ? v : [''];
    } catch {
      return [''];
    }
  });
  const [people, setPeople] = useState(2);
  const [seatMode, setSeatMode] = useState<'auto' | 'none'>('auto');
  const [preferred, setPreferred] = useState('');
  const [sternSide, setSternSide] = useState<'right' | 'left'>('right');
  const [name, setName] = useState(() => load(LS.name));
  const [phone, setPhone] = useState(() => load(LS.phone));
  const [openAt, setOpenAt] = useState('');

  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPayload, setShowPayload] = useState<Record<string, boolean>>({});
  const keyRef = useRef(adminKey);
  keyRef.current = adminKey;

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(`/api/booking${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-booking-key': keyRef.current, ...(init?.headers ?? {}) },
    });
    if (res.status === 401) {
      setNeedKey(true);
      throw new Error('접근 키를 입력하세요');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `오류 (${res.status})`);
    return body;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api('/status');
      setNeedKey(false);
      setRelayOk(s.relay);
      const j = await api('/jobs');
      setJobs(j.jobs);
    } catch {
      /* 오류 문구는 요청을 보낸 곳에서만 표시 */
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [refresh, adminKey]);

  const setShip = (i: number, v: string) => setShips((s) => s.map((x, k) => (k === i ? v : x)));
  const addShip = (v = '') => setShips((s) => (s.includes(v) && v ? s : s.length === 1 && !s[0] ? [v] : [...s, v]));

  async function start() {
    setError('');
    const list = ships.map((s) => s.trim()).filter(Boolean);
    if (!date) return setError('날짜를 선택하세요');
    if (!list.length) return setError('배를 한 척 이상 입력하세요');
    if (!name.trim()) return setError('예약자명을 입력하세요');
    if (!phone.trim()) return setError('휴대폰 번호를 입력하세요');
    save(LS.name, name);
    save(LS.phone, phone);
    save(LS.ships, JSON.stringify(list));
    setBusy(true);
    try {
      await api('/jobs', {
        method: 'POST',
        body: JSON.stringify({
          baseUrl: 'http://www.mscufishing.com',
          date: date.replace(/-/g, ''),
          ships: list.map((n) => ({ name: n })),
          people,
          seatMode,
          preferredSeats: preferred
            .split(/[,\s]+/)
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0),
          sternSide,
          name: name.trim(),
          phone,
          openAt: openAt ? `${openAt}:00+09:00` : undefined, // 한국 시간 기준
        }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '시작하지 못했습니다');
    } finally {
      setBusy(false);
    }
  }

  async function stop(id: string) {
    try {
      await api(`/jobs/${id}/stop`, { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '중지하지 못했습니다');
    }
  }

  const input = 'h-10 w-full rounded-lg border bg-background px-3 text-sm';
  const label = 'mb-1 block text-xs font-medium text-muted-foreground';

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="rounded-lg p-2 hover:bg-accent" aria-label="돌아가기">
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-lg font-semibold">자동 예약</h2>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">테스트 모드 · 제출 안 함</span>
      </div>

      {relayOk === false && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          닷홈 중계기 설정(BOOKING_RELAY_URL, BOOKING_RELAY_TOKEN)이 없어 서버에서 직접 요청합니다. 해외 서버에서는 막힐 수 있어요.
        </p>
      )}

      {needKey && (
        <div className="rounded-lg border p-3">
          <label className={label}>접근 키 (Secrets의 BOOKING_ADMIN_KEY)</label>
          <input
            type="password"
            className={input}
            value={adminKey}
            onChange={(e) => {
              setAdminKey(e.target.value);
              save(LS.key, e.target.value);
            }}
          />
        </div>
      )}

      <section className="space-y-4 rounded-xl border p-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>출조 날짜</label>
            <input type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className={label}>인원</label>
            <select className={input} value={people} onChange={(e) => setPeople(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}명
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className={label}>배 (위에 있을수록 우선) — 예약처: 미스쿠 낚시</label>
          <div className="space-y-2">
            {ships.map((s, i) => (
              <div key={i} className="flex gap-2">
                <span className="flex h-10 w-6 items-center justify-center text-xs text-muted-foreground">{i + 1}</span>
                <input className={input} placeholder="배 이름 (예: 헌터호)" value={s} onChange={(e) => setShip(i, e.target.value)} />
                {ships.length > 1 && (
                  <button type="button" className="rounded-lg border px-2" onClick={() => setShips((x) => x.filter((_, k) => k !== i))} aria-label="삭제">
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {KNOWN_SHIPS.map((k) => (
              <button key={k} type="button" onClick={() => addShip(k)} className="rounded-full border px-2.5 py-1 text-xs hover:bg-accent">
                {k}
              </button>
            ))}
            <button type="button" onClick={() => setShips((s) => [...s, ''])} className="flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs">
              <Plus size={12} />
              직접 추가
            </button>
          </div>
        </div>

        <div>
          <label className={label}>낚시 종류</label>
          <p className="h-10 rounded-lg bg-muted px-3 text-sm leading-10">쭈꾸미 · 갑오징어 (고정)</p>
        </div>

        <div>
          <label className={label}>좌석</label>
          <div className="grid grid-cols-2 gap-3">
            <select className={input} value={seatMode} onChange={(e) => setSeatMode(e.target.value as 'auto' | 'none')}>
              <option value="auto">좌석 선택 (선미 우선)</option>
              <option value="none">좌석 선택 안 함</option>
            </select>
            <select className={input} value={sternSide} onChange={(e) => setSternSide(e.target.value as 'right' | 'left')} disabled={seatMode === 'none'}>
              <option value="right">선미 같은 줄이면 오른쪽 먼저</option>
              <option value="left">선미 같은 줄이면 왼쪽 먼저</option>
            </select>
          </div>
          {seatMode === 'auto' && <input className={`${input} mt-2`} placeholder="원하는 좌석 번호 (선택, 예: 10, 11)" value={preferred} onChange={(e) => setPreferred(e.target.value)} />}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>예약자명</label>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </div>
          <div>
            <label className={label}>휴대폰 번호</label>
            <input className={input} inputMode="tel" placeholder="010-1234-5678" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
          </div>
        </div>
        <p className="-mt-2 text-[11px] text-muted-foreground">이름·번호는 이 기기 브라우저에만 저장됩니다. 입금자명은 사용하지 않습니다.</p>

        <div>
          <label className={label}>오픈 시각 (한국 시간, 비워두면 지금 바로 시작)</label>
          <input type="datetime-local" className={input} value={openAt} onChange={(e) => setOpenAt(e.target.value)} />
        </div>

        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}

        <button
          type="button"
          onClick={() => void start()}
          disabled={busy}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Play size={16} />}
          테스트 실행 (제출은 하지 않아요)
        </button>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">작업 현황</h3>
        {jobs.length === 0 && <p className="text-xs text-muted-foreground">아직 실행한 작업이 없습니다.</p>}
        {jobs.map((j) => {
          const active = j.status === 'waiting' || j.status === 'polling';
          return (
            <div key={j.id} className="space-y-2 rounded-xl border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[j.status]}`}>{STATUS_LABEL[j.status]}</span>
                  <p className="mt-1 break-words text-sm">{j.summary}</p>
                </div>
                {active && (
                  <button type="button" onClick={() => void stop(j.id)} className="flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs">
                    <Square size={12} />
                    중지
                  </button>
                )}
              </div>
              {j.error && <p className="text-xs text-red-700">{j.error}</p>}
              {j.result && (
                <div className="space-y-1 rounded-lg bg-muted p-2.5 text-xs">
                  <p>
                    <b>{j.result.ship.name}</b> · {j.result.species} · {j.result.people}명 · {j.result.price}
                  </p>
                  <p>좌석: {j.result.seats.length ? j.result.seats.join(', ') + '번' : '선택 안 함'} ({j.result.seatNote})</p>
                  {j.result.unresolved.length > 0 && <p className="text-amber-800">확인 필요: {j.result.unresolved.join(', ')}</p>}
                  <button type="button" className="underline" onClick={() => setShowPayload((p) => ({ ...p, [j.id]: !p[j.id] }))}>
                    제출될 내용 {showPayload[j.id] ? '숨기기' : '보기'}
                  </button>
                  {showPayload[j.id] && <p className="break-all font-mono text-[10px]">{maskPayload(j.result.payload)}</p>}
                </div>
              )}
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">진행 기록 ({j.log.length})</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">{j.log.join('\n')}</pre>
              </details>
            </div>
          );
        })}
      </section>
    </div>
  );
}
