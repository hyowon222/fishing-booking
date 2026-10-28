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
  dryRun?: boolean;
  deposit?: string;
  submit?: { state: 'success' | 'failed' | 'unknown'; message: string; reservationNo?: string };
};
type Job = {
  id: string;
  createdAt: number;
  status: 'waiting' | 'polling' | 'submitting' | 'done' | 'failed' | 'stopped';
  summary: string;
  log: string[];
  result?: BookingResult;
  error?: string;
};

type Site = { id: string; label: string; url: string; hint: string; seat: boolean; ships?: string[]; custom?: boolean };
const BUILTIN_SITES: Site[] = [
  { id: 'mscu', label: '삼길포 CU 만석낚시', url: 'http://www.mscufishing.com', hint: '자리 지정 선사 · 배 이름으로 선택', seat: true },
  { id: 'daebak', label: '뉴항구호', url: 'https://daebak.sunsang24.com', hint: '자리 지정 선사 (선상24)', seat: true, ships: ['뉴항구호'] },
];
const LS_SITES = 'autoBooking.sites';
function loadSites(): Site[] {
  try {
    const v = JSON.parse(load(LS_SITES, '[]'));
    return Array.isArray(v) ? v.filter((x) => x && x.id && x.url).map((x) => ({ id: String(x.id), label: String(x.label || x.url), url: String(x.url), hint: x.seat ? '자리 지정 선사' : '자리 지정 없는 선사', seat: !!x.seat, custom: true })) : [];
  } catch {
    return [];
  }
}
const KNOWN_SHIPS = ['승주호', '헌터호', '골드피싱', '으리호', '블루오션', '바다호', '영스타호', '뚜기호', '유리호', '나대세호', '아산호', '박찬호', '히트호', '헤르메스호', '만석호'];
const STATUS_LABEL: Record<Job['status'], string> = { waiting: '오픈 대기', polling: '배 찾는 중', submitting: '제출 중', done: '입력 준비 완료', failed: '실패', stopped: '중지됨' };
const STATUS_STYLE: Record<Job['status'], string> = {
  waiting: 'bg-amber-100 text-amber-800',
  polling: 'bg-blue-100 text-blue-800',
  submitting: 'bg-red-100 text-red-800',
  done: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  stopped: 'bg-muted text-muted-foreground',
};
// 실제 제출을 한 작업은 제출 결과로 라벨을 바꿔 보여 준다
function statusInfo(j: Job): { label: string; style: string } {
  const st = j.result?.submit?.state;
  if (j.status === 'done' && st === 'success') return { label: '예약 접수됨', style: 'bg-emerald-100 text-emerald-800' };
  if (j.status === 'done' && st === 'unknown') return { label: '제출함 · 확인 필요', style: 'bg-amber-100 text-amber-800' };
  return { label: STATUS_LABEL[j.status], style: STATUS_STYLE[j.status] };
}

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

// 예약처마다 따로 갖는 설정
type SiteCfg = { ships: string[]; seatMode: 'auto' | 'none'; preferred: string; same: boolean; name: string; phone: string; sameDates: boolean; dates: string[] };
const shipsKey = (id: string) => `autoBooking.ships.${id}`;
const bookerKey = (id: string) => `autoBooking.booker.${id}`;
function defaultSiteCfg(s: Site): SiteCfg {
  let ships: string[] = [''];
  try {
    // 예전 버전은 배 목록을 하나만 저장했으므로, 마지막으로 쓴 예약처에만 그 목록을 이어 준다
    const raw = load(shipsKey(s.id)) || (load('autoBooking.site', 'mscu') === s.id ? load(LS.ships) : '');
    const v = JSON.parse(raw || '[]');
    if (Array.isArray(v) && v.length) ships = v.map(String);
  } catch {
    /* 기본값 */
  }
  let b = { same: true, name: '', phone: '' };
  try {
    const v = JSON.parse(load(bookerKey(s.id), 'null'));
    if (v && typeof v === 'object') b = { same: v.same !== false, name: String(v.name ?? ''), phone: String(v.phone ?? '') };
  } catch {
    /* 기본값 */
  }
  return { ships, seatMode: s.seat ? 'auto' : 'none', preferred: '', sameDates: true, dates: [], ...b };
}

function maskPayload(p: string) {
  // 화면 표시용: 이름·전화번호 값은 가림
  return p.replace(/(BI_NAME=)[^&]*/, '$1***').replace(/(BI_TEL2=)[^&]*/, '$1****').replace(/(BI_TEL3=)[^&]*/, '$1****');
}

export default function AutoBooking({ onBack }: { onBack: () => void }) {
  const [adminKey, setAdminKey] = useState(() => load(LS.key));
  const [needKey, setNeedKey] = useState(false);
  const [relayOk, setRelayOk] = useState<boolean | null>(null);

  // 예약처는 여러 곳을 동시에 고를 수 있다 (곳마다 따로 진행)
  const [sel, setSel] = useState<string[]>(() => {
    try {
      const v = JSON.parse(load('autoBooking.sel', '[]'));
      if (Array.isArray(v) && v.length) return v.map(String);
    } catch {
      /* 저장된 값이 없으면 아래 기본값 */
    }
    return [load('autoBooking.site', 'mscu')];
  });
  const [mySites, setMySites] = useState<Site[]>(loadSites);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newSeat, setNewSeat] = useState(false);
  const [directUrl, setDirectUrl] = useState(() => load('autoBooking.directUrl'));
  const DIRECT: Site = { id: 'direct', label: '직접 URL 입력', url: directUrl.trim(), hint: '더피싱·선상24 주소를 바로 입력해서 예약 (저장 안 해도 돼요)', seat: false };
  const allSites = [...BUILTIN_SITES, ...mySites];
  const siteOf = (id: string): Site | undefined => (id === 'direct' ? DIRECT : allSites.find((x) => x.id === id));
  const selSites = sel.map(siteOf).filter((x): x is Site => !!x);
  const toggleSite = (id: string) => {
    const next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
    setSel(next);
    save('autoBooking.sel', JSON.stringify(next));
  };
  // 예약처별 설정 (배 우선순위·좌석·예약자). 건드리지 않은 곳은 기본값
  const [cfgMap, setCfgMap] = useState<Record<string, SiteCfg>>({});
  const cfgOf = (s: Site): SiteCfg => cfgMap[s.id] ?? defaultSiteCfg(s);
  const setCfg = (s: Site, v: Partial<SiteCfg>) => setCfgMap((m) => ({ ...m, [s.id]: { ...(m[s.id] ?? defaultSiteCfg(s)), ...v } }));
  const [dates, setDates] = useState<string[]>([]);
  const [dateInput, setDateInput] = useState('');
  const [siteDateInput, setSiteDateInput] = useState<Record<string, string>>({});
  const [stopOthers, setStopOthers] = useState(false);
  const [people, setPeople] = useState(2);
  const [sternSide, setSternSide] = useState<'right' | 'left'>('right');
  const [name, setName] = useState(() => load(LS.name));
  const [phone, setPhone] = useState(() => load(LS.phone));
  const [openAt, setOpenAt] = useState('');
  // 실제 제출 모드 (화면을 열 때마다 항상 테스트 모드로 시작)
  const [realMode, setRealMode] = useState(false);
  const [realOk, setRealOk] = useState(false);
  // 예약처·날짜별 예약자: same=true 이면 맨 위 공통 예약자를 그대로 쓴다 (기본값)
  const [bookerMap, setBookerMap] = useState<Record<string, { same: boolean; name: string; phone: string }>>({});
  const bookerOf = (s: Site, d: string) => bookerMap[`${s.id}|${d}`] ?? { same: true, name: '', phone: '' };
  const setBooker = (s: Site, d: string, v: Partial<{ same: boolean; name: string; phone: string }>) =>
    setBookerMap((m) => ({ ...m, [`${s.id}|${d}`]: { ...bookerOf(s, d), ...v } }));
  // 예약처별 실제 출조 날짜: "공통 날짜 사용"이면 위의 공통 날짜, 아니면 그 예약처에 따로 정한 날짜
  const datesOf = (s: Site): string[] => [...(cfgOf(s).sameDates ? dates : cfgOf(s).dates)].sort();
  const allDates = [...new Set(selSites.flatMap(datesOf))].sort();
  const addSiteDate = (s: Site) => {
    const v = siteDateInput[s.id];
    const c = cfgOf(s);
    if (v && !c.dates.includes(v) && c.dates.length < 10) setCfg(s, { dates: [...c.dates, v].sort() });
    setSiteDateInput((m) => ({ ...m, [s.id]: '' }));
  };
  // 예약처·날짜마다 실제 적용될 예약자: 따로 입력하지 않았으면 위의 공통 예약자
  const effectiveBookers = (s: Site) => {
    const base = { name: name.trim(), phone };
    const out: Record<string, { name: string; phone: string }> = {};
    datesOf(s).forEach((d) => {
      const b = bookerOf(s, d);
      out[d.replace(/-/g, '')] = b.same ? base : { name: b.name.trim(), phone: b.phone };
    });
    return out;
  };

  const [jobs, setJobs] = useState<Job[]>([]);
  // 집 PC 중계: null = 사용 안 함, true = 연결됨, false = 꺼져 있음
  const [home, setHome] = useState<boolean | null>(null);
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
      setHome(s.home?.enabled ? Boolean(s.home.online) : null);
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

  const setShip = (s: Site, i: number, v: string) => setCfg(s, { ships: cfgOf(s).ships.map((x, k) => (k === i ? v : x)) });
  const addShip = (s: Site, v = '') => {
    const cur = cfgOf(s).ships;
    setCfg(s, { ships: cur.includes(v) && v ? cur : cur.length === 1 && !cur[0] ? [v] : [...cur, v] });
  };

  async function start() {
    setError('');
    if (!selSites.length) return setError('예약처를 한 곳 이상 선택하세요');
    for (const s of selSites) if (!datesOf(s).length) return setError(`${s.label}: 출조 날짜를 한 개 이상 추가하세요`);
    // 예약처마다 요청 내용을 만들고 빠짐없이 확인한다
    const targets: { site: Site; cfg: SiteCfg; list: string[]; days: string[]; bookers: Record<string, { name: string; phone: string }> }[] = [];
    for (const site of selSites) {
      if (!site.url) return setError(`${site.label}: 예약처 주소를 입력하세요`);
      const cfg = cfgOf(site);
      const bookers = effectiveBookers(site);
      for (const [d, b] of Object.entries(bookers)) {
        if (!b.name) return setError(`${site.label} ${d.slice(4, 6)}/${d.slice(6)} 예약자명을 입력하세요`);
        if (!b.phone.trim()) return setError(`${site.label} ${d.slice(4, 6)}/${d.slice(6)} 휴대폰 번호를 입력하세요`);
      }
      targets.push({ site, cfg, list: cfg.ships.map((x) => x.trim()).filter(Boolean), days: datesOf(site), bookers });
    }
    const running = jobs.filter((j) => ['waiting', 'polling', 'submitting'].includes(j.status)).length;
    const newJobs = targets.reduce((a, t) => a + t.days.length, 0);
    if (running + newJobs > 12) {
      return setError(`동시에 진행할 수 있는 작업은 12개까지예요. (새 작업 ${newJobs}개 = ${targets.map((t) => `${t.site.label} ${t.days.length}`).join(' + ')}, 현재 진행 중 ${running}개)`);
    }
    if (selSites.some((x) => x.id === 'direct')) save('autoBooking.directUrl', directUrl);
    save(LS.name, name);
    save(LS.phone, phone);
    save('autoBooking.sel', JSON.stringify(sel));
    save('autoBooking.site', sel[0]);
    for (const t of targets) {
      save(shipsKey(t.site.id), JSON.stringify(t.list));
    }
    if (realMode) {
      if (!realOk) return setError('실제 제출을 시작하려면 아래 확인란에 체크해 주세요');
      const blocks = targets
        .map((t) => {
          const lines = t.days.map((d) => `  • ${d.slice(5)}  ${t.bookers[d.replace(/-/g, '')].name} (${t.bookers[d.replace(/-/g, '')].phone})`).join('\n');
          return `■ ${t.site.label}\n${t.list.length ? t.list.join(' > ') : '열린 배 아무거나'}\n${lines}`;
        })
        .join('\n\n');
      const ok = window.confirm(
        `실제로 예약을 제출합니다. (${targets.length}곳)\n\n${blocks}\n\n${people}명\n${openAt ? `오픈 ${openAt.replace('T', ' ')} 부터` : '지금 바로 시작'}\n\n예약처마다 따로 진행되며, 자리가 잡히면 확인 없이 바로 접수됩니다. 계속할까요?`,
      );
      if (!ok) return;
    }
    setBusy(true);
    const failed: string[] = [];
    let started = 0;
    // 예약처마다 요청을 하나씩 보낸다 (한 곳이 실패해도 나머지는 계속 시작)
    for (const t of targets) {
      const first = t.bookers[t.days[0].replace(/-/g, '')];
      try {
        await api('/jobs', {
          method: 'POST',
          body: JSON.stringify({
            baseUrl: t.site.url,
            dates: t.days.map((d) => d.replace(/-/g, '')),
            stopOthersOnSuccess: stopOthers && t.days.length > 1,
            ships: t.list.map((n) => ({ name: n })),
            people,
            seatMode: t.cfg.seatMode,
            preferredSeats: t.cfg.preferred
              .split(/[,\s]+/)
              .map(Number)
              .filter((n) => Number.isInteger(n) && n > 0),
            sternSide,
            name: first.name,
            phone: first.phone,
            bookers: t.bookers,
            openAt: openAt ? `${openAt}:00+09:00` : undefined, // 한국 시간 기준
            submit: realMode, // true 일 때만 실제로 제출
          }),
        });
        started++;
      } catch (e) {
        failed.push(`${t.site.label}: ${e instanceof Error ? e.message : '시작하지 못했습니다'}`);
      }
    }
    if (failed.length) setError(`${started ? `${started}곳은 시작했고, ` : ''}${failed.length}곳은 시작하지 못했어요 — ${failed.join(' / ')}`);
    if (started) setRealOk(false); // 다음 실제 제출은 매번 다시 확인
    await refresh();
    setBusy(false);
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
        {realMode ? (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">실제 제출 모드</span>
        ) : (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">테스트 모드 · 제출 안 함</span>
        )}
      </div>

      {home !== null && (
        <p className={`rounded-lg border p-3 text-xs ${home ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-amber-300 bg-amber-50 text-amber-900'}`} data-testid="text-home-status">
          {home ? '집 PC 연결됨 · 더피싱 같은 막힌 사이트도 예약할 수 있어요.' : '집 PC가 꺼져 있어요. 더피싱 같은 막힌 사이트는 집 PC를 켜야 예약돼요. (start.bat 실행)'}
        </p>
      )}

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
        <div>
          <label className={label}>예약처 (여러 곳을 골라 동시에 진행할 수 있어요)</label>
          <div className="space-y-1.5">
            {[...allSites, DIRECT].map((x) => {
              const on = sel.includes(x.id);
              return (
                <div key={x.id} className={`rounded-lg border p-2.5 ${on ? 'border-primary bg-primary/5' : ''}`}>
                  <div className="flex items-start gap-2">
                    <label className="flex min-w-0 flex-1 items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-0.5" checked={on} onChange={() => toggleSite(x.id)} />
                      <span className="min-w-0">
                        <span className="block font-medium">{x.label}</span>
                        <span className="block break-all text-[11px] text-muted-foreground">
                          {x.hint}
                          {x.url ? ` · ${x.url}` : ''}
                        </span>
                      </span>
                    </label>
                    {x.custom && (
                      <button
                        type="button"
                        className="shrink-0 text-[11px] text-red-600 underline"
                        onClick={() => {
                          if (!confirm(`'${x.label}' 예약처를 삭제할까요?`)) return;
                          const next = mySites.filter((y) => y.id !== x.id);
                          setMySites(next);
                          save(LS_SITES, JSON.stringify(next));
                          const left = sel.filter((id) => id !== x.id);
                          const nextSel = left.length ? left : ['mscu'];
                          setSel(nextSel);
                          save('autoBooking.sel', JSON.stringify(nextSel));
                        }}
                      >
                        삭제
                      </button>
                    )}
                  </div>
                  {x.id === 'direct' && on && (
                    <div className="mt-2 space-y-2">
                      <input
                        className={input}
                        placeholder="예약처 주소 (예: http://vipfishing.kr 또는 https://xxx.sunsang24.com)"
                        value={directUrl}
                        onChange={(e) => {
                          setDirectUrl(e.target.value);
                          save('autoBooking.directUrl', e.target.value);
                        }}
                      />
                      <button
                        type="button"
                        className="text-[11px] underline"
                        onClick={() => {
                          setNewUrl(directUrl);
                          setNewSeat(cfgOf(DIRECT).seatMode === 'auto');
                          setAdding(true);
                        }}
                      >
                        이 주소를 예약처 목록에 저장
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button type="button" className="mt-2 flex items-center gap-1 text-xs underline" onClick={() => setAdding(true)}>
            <Plus size={12} />
            예약처 추가
          </button>
          {adding && (
            <div className="mt-2 space-y-2 rounded-lg border p-3">
              <input className={input} placeholder="예약처 이름 (예: 으리호)" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <input className={input} placeholder="주소 (예: https://xxx.sunsang24.com 또는 http://xxx.thefishing.kr)" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} />
              <select className={input} value={newSeat ? 'seat' : 'free'} onChange={(e) => setNewSeat(e.target.value === 'seat')}>
                <option value="free">자리 지정 없는 선사</option>
                <option value="seat">자리 지정 선사</option>
              </select>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                  onClick={() => {
                    let url = newUrl.trim();
                    if (!url) return setError('예약처 주소를 입력하세요');
                    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
                    try {
                      url = new URL(url).origin;
                    } catch {
                      return setError('예약처 주소가 올바르지 않습니다');
                    }
                    const id = `u${Date.now()}`;
                    const next = [...mySites, { id, label: newName.trim() || new URL(url).hostname, url, hint: newSeat ? '자리 지정 선사' : '자리 지정 없는 선사', seat: newSeat, custom: true }];
                    setMySites(next);
                    save(LS_SITES, JSON.stringify(next));
                    const nextSel = [...sel.filter((v) => v !== 'direct'), id];
                    setSel(nextSel);
                    save('autoBooking.sel', JSON.stringify(nextSel));
                    setAdding(false);
                    setNewName('');
                    setNewUrl('');
                    setError('');
                  }}
                >
                  추가
                </button>
                <button type="button" className="rounded-lg border px-3 py-2 text-sm" onClick={() => setAdding(false)}>
                  취소
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">이 기기 브라우저에 저장돼요. 더피싱·선상24 계열 주소를 넣으면 됩니다.</p>
            </div>
          )}
          {selSites.length > 1 && (
            <p className="mt-2 rounded-lg bg-muted p-2 text-[11px] text-muted-foreground">
              선택한 {selSites.length}곳을 동시에 진행해요. 예약처마다 작업이 따로 만들어지고 서로 영향을 주지 않으니, 같은 날짜가 두 곳에서 모두 잡히면 둘 다 접수될 수 있어요.
            </p>
          )}
        </div>

        <div>
          <label className={label}>{selSites.length > 1 ? '공통 출조 날짜' : '출조 날짜'} (여러 날짜를 추가하면 날짜마다 동시에 진행해요, 최대 10개){selSites.length > 1 ? ' · 예약처마다 따로 정하려면 아래 예약처 설정에서 "공통 날짜 사용"을 끄세요' : ''}</label>
          <div className="flex gap-2">
            <input type="date" className={input} value={dateInput} onChange={(e) => setDateInput(e.target.value)} />
            <button
              type="button"
              className="shrink-0 rounded-lg border px-3 text-sm"
              onClick={() => {
                if (dateInput && !dates.includes(dateInput) && dates.length < 10) setDates((d) => [...d, dateInput].sort());
                setDateInput('');
              }}
            >
              추가
            </button>
          </div>
          {dates.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {dates.map((d) => (
                <span key={d} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs">
                  {d.slice(5).replace('-', '/')}
                  <button type="button" onClick={() => setDates((x) => x.filter((v) => v !== d))} aria-label="날짜 삭제">
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {selSites.some((s) => datesOf(s).length > 1) && (
            <label className="mt-2 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={stopOthers} onChange={(e) => setStopOthers(e.target.checked)} />
              한 날짜가 준비되면 나머지 날짜는 중지{selSites.length > 1 ? ' (예약처마다 따로 적용)' : ''}
            </label>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>인원 (모든 예약처 공통)</label>
            <select className={input} value={people} onChange={(e) => setPeople(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}명
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>선미 같은 줄이면 (자리 지정 선사)</label>
            <select className={input} value={sternSide} onChange={(e) => setSternSide(e.target.value as 'right' | 'left')}>
              <option value="right">오른쪽 먼저</option>
              <option value="left">왼쪽 먼저</option>
            </select>
          </div>
        </div>

        <div>
          <label className={label}>낚시 종류</label>
          <p className="rounded-lg bg-muted px-3 py-2 text-sm leading-6">쭈꾸미 · 갑오징어 · 쭈갑 (이 중 하나라도 있으면 진행)</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>{selSites.length > 1 ? '공통 예약자명' : '예약자명'}</label>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </div>
          <div>
            <label className={label}>{selSites.length > 1 ? '공통 휴대폰 번호' : '휴대폰 번호'}</label>
            <input className={input} inputMode="tel" placeholder="010-1234-5678" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
          </div>
        </div>
        <p className="-mt-2 text-[11px] text-muted-foreground">
          이름·번호는 이 기기 브라우저에만 저장됩니다. 입금자명은 사용하지 않습니다.
          {selSites.length > 1 || allDates.length > 1 ? ' 예약처·날짜마다 다른 사람으로 예약하려면 아래 각 예약처의 "날짜별 예약자"에서 바꾸세요.' : ''}
        </p>

        {selSites.map((x, idx) => {
          const c = cfgOf(x);
          return (
            <div key={x.id} className="space-y-3 rounded-lg border-2 border-primary/30 p-3">
              <div className="text-sm font-semibold">
                {selSites.length > 1 ? `${idx + 1}. ` : ''}
                {x.label} 설정
              </div>

              {selSites.length > 1 && (
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={c.sameDates}
                      onChange={(e) => setCfg(x, { sameDates: e.target.checked, ...(!e.target.checked && c.dates.length === 0 ? { dates: [...dates] } : {}) })}
                    />
                    공통 날짜 사용{c.sameDates ? ` (${dates.length ? dates.map((d) => d.slice(5).replace('-', '/')).join(', ') : '날짜 없음'})` : ''}
                  </label>
                  {!c.sameDates && (
                    <div>
                      <label className={label}>이 예약처 출조 날짜 (최대 10개)</label>
                      <div className="flex gap-2">
                        <input type="date" className={input} value={siteDateInput[x.id] ?? ''} onChange={(e) => setSiteDateInput((m) => ({ ...m, [x.id]: e.target.value }))} />
                        <button type="button" className="shrink-0 rounded-lg border px-3 text-sm" onClick={() => addSiteDate(x)}>
                          추가
                        </button>
                      </div>
                      {c.dates.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {c.dates.map((d) => (
                            <span key={d} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs">
                              {d.slice(5).replace('-', '/')}
                              <button type="button" onClick={() => setCfg(x, { dates: c.dates.filter((v) => v !== d) })} aria-label="날짜 삭제">
                                <X size={12} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className={label}>배 (위에 있을수록 우선, 비워두면 열린 배 아무거나)</label>
                <div className="space-y-2">
                  {c.ships.map((sh, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="flex h-10 w-6 items-center justify-center text-xs text-muted-foreground">{i + 1}</span>
                      <input className={input} placeholder="배 이름 (예: 헌터호)" value={sh} onChange={(e) => setShip(x, i, e.target.value)} />
                      {c.ships.length > 1 && (
                        <button type="button" className="rounded-lg border px-2" onClick={() => setCfg(x, { ships: c.ships.filter((_, k) => k !== i) })} aria-label="삭제">
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(x.id === 'mscu' ? KNOWN_SHIPS : (x.ships ?? [])).map((k) => (
                    <button key={k} type="button" onClick={() => addShip(x, k)} className="rounded-full border px-2.5 py-1 text-xs hover:bg-accent">
                      {k}
                    </button>
                  ))}
                  <button type="button" onClick={() => setCfg(x, { ships: [...c.ships, ''] })} className="flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs">
                    <Plus size={12} />
                    직접 추가
                  </button>
                </div>
              </div>

              <div>
                <label className={label}>좌석</label>
                <select className={input} value={c.seatMode} onChange={(e) => setCfg(x, { seatMode: e.target.value as 'auto' | 'none' })}>
                  <option value="auto">자리 지정 선사 (지정·선미 우선)</option>
                  <option value="none">자리 지정 없는 선사</option>
                </select>
                {c.seatMode === 'auto' && <input className={`${input} mt-2`} placeholder="원하는 좌석 번호 (선택, 예: 10, 11)" value={c.preferred} onChange={(e) => setCfg(x, { preferred: e.target.value })} />}
              </div>

              {(selSites.length > 1 || datesOf(x).length > 1) && datesOf(x).length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">날짜별 예약자 (기본은 위의 공통 예약자)</div>
                  {datesOf(x).map((d) => {
                    const b = bookerOf(x, d);
                    return (
                      <div key={d} className="space-y-2 rounded border p-2">
                        <label className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={b.same} onChange={(e) => setBooker(x, d, { same: e.target.checked })} />
                          <b>{d.slice(5).replace('-', '/')}</b> 공통 예약자
                        </label>
                        {!b.same && (
                          <div className="grid grid-cols-2 gap-2">
                            <input className={input} placeholder="예약자명" value={b.name} onChange={(e) => setBooker(x, d, { name: e.target.value })} autoComplete="off" />
                            <input className={input} inputMode="tel" placeholder="010-1234-5678" value={b.phone} onChange={(e) => setBooker(x, d, { phone: e.target.value })} autoComplete="off" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        <div>
          <label className={label}>오픈 시각 (한국 시간, 비워두면 지금 바로 시작)</label>
          <input type="datetime-local" className={input} value={openAt} onChange={(e) => setOpenAt(e.target.value)} />
        </div>

        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}

        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-sm">
            <button
              type="button"
              onClick={() => {
                setRealMode(false);
                setRealOk(false);
              }}
              className={`h-9 rounded-md ${!realMode ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'}`}
            >
              테스트 실행
            </button>
            <button type="button" onClick={() => setRealMode(true)} className={`h-9 rounded-md ${realMode ? 'bg-red-600 font-medium text-white shadow-sm' : 'text-muted-foreground'}`}>
              실제 제출
            </button>
          </div>
          {realMode && (
            <div className="space-y-2 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900">
              <p className="font-medium">실제로 예약이 접수됩니다.</p>
              <p>자리가 잡히면 확인 없이 바로 제출돼요. 접수된 예약은 예약처의 입금·취소 규정이 그대로 적용되고, 취소는 예약처에서 직접 해야 합니다. 처음에는 테스트 실행으로 먼저 확인해 보세요.</p>
              {selSites.length > 1 && <p className="font-medium">예약처 {selSites.length}곳이 각각 따로 제출됩니다. 같은 날짜가 두 곳 이상에서 잡히면 모두 접수되니, 꼭 필요한 곳만 고르세요.</p>}
              <p>서버가 다시 시작되면(코드 반영·배포 직후 등) 대기 중인 작업이 사라질 수 있어요. 오픈 전에는 배포하지 말고, 시작한 뒤 작업 현황에 "오픈 대기"로 보이는지 확인하세요.</p>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={realOk} onChange={(e) => setRealOk(e.target.checked)} />
                <span>예약처·날짜·인원·예약자 정보를 확인했고, 실제로 제출하는 데 동의합니다.</span>
              </label>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || (realMode && !realOk)}
          className={`flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium disabled:opacity-60 ${realMode ? 'bg-red-600 text-white' : 'bg-primary text-primary-foreground'}`}
        >
          {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Play size={16} />}
          {realMode ? '실제 예약 시작 (자리를 잡으면 바로 제출)' : '테스트 실행 (제출은 하지 않아요)'}
        </button>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">작업 현황</h3>
        {jobs.length === 0 && <p className="text-xs text-muted-foreground">아직 실행한 작업이 없습니다.</p>}
        {jobs.map((j) => {
          const active = j.status === 'waiting' || j.status === 'polling';
          const info = statusInfo(j);
          const sub = j.result?.submit;
          return (
            <div key={j.id} className="space-y-2 rounded-xl border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${info.style}`}>{info.label}</span>
                  <p className="mt-1 break-words text-sm">{j.summary}</p>
                </div>
                {active && (
                  <button type="button" onClick={() => void stop(j.id)} className="flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs">
                    <Square size={12} />
                    중지
                  </button>
                )}
              </div>
              {j.error && !sub && <p className="text-xs text-red-700">{j.error}</p>}
              {sub && (
                <div
                  className={`space-y-1 rounded-lg border p-2.5 text-xs ${
                    sub.state === 'success' ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : sub.state === 'failed' ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900'
                  }`}
                >
                  <p className="font-medium">{sub.state === 'success' ? '예약이 접수됐어요' : sub.state === 'failed' ? '예약이 접수되지 않았어요' : '제출은 했는데 결과를 확인하지 못했어요'}</p>
                  {sub.reservationNo && <p>예약번호 {sub.reservationNo}</p>}
                  <p className="break-words">{sub.message}</p>
                  {j.result?.deposit && sub.state !== 'failed' && <p className="break-words">입금 안내(예상): {j.result.deposit}</p>}
                  {sub.state === 'success' && <p>예약처 사이트의 예약 조회에서 이름·전화번호로 확인할 수 있어요. 입금 기한은 예약처 안내를 꼭 확인하세요.</p>}
                  {sub.state === 'unknown' && <p>예약처 사이트의 예약 조회에서 직접 확인하세요. 접수됐다면 같은 예약을 다시 제출하지 마세요(중복 예약).</p>}
                </div>
              )}
              {j.result && (
                <div className="space-y-1 rounded-lg bg-muted p-2.5 text-xs">
                  <p>
                    <b>{j.result.ship.name}</b> · {j.result.species} · {j.result.people}명 · {j.result.price}
                  </p>
                  <p>좌석: {j.result.seats.length ? j.result.seats.join(', ') + '번' : '선택 안 함'} ({j.result.seatNote})</p>
                  {j.result.unresolved.length > 0 && <p className="text-amber-800">확인 필요: {j.result.unresolved.join(', ')}</p>}
                  <button type="button" className="underline" onClick={() => setShowPayload((p) => ({ ...p, [j.id]: !p[j.id] }))}>
                    {j.result.dryRun === false ? '제출한 내용' : '제출될 내용'} {showPayload[j.id] ? '숨기기' : '보기'}
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
