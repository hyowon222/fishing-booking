import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ClipboardPaste, Fish, LoaderCircle, Plus, Star, Trash2, X } from 'lucide-react';

type Report = { id: number; date: string; port: string; vessel: string; species: string; count: number | null; note: string; markedGood: boolean; source: string };
type GoodDay = {
  date: string;
  weekday: string;
  port: string;
  totalCount: number | null;
  reasons: string[];
  vessels: string[];
  species: string[];
  reports: Report[];
  mulddae: string | null;
  flowPercent: number | null;
  flowLabel: string | null;
  weather: { am: string; pm: string } | null;
  tideRange: number | null;
  tideNote: string | null;
};
type Tally = Array<{ label: string; days: number }>;
type Insights = { from: string; to: string; totalReports: number; days: GoodDay[]; byMulddae: Tally; byFlow: Tally; byPort: Tally; topPercent: number };

const PORTS = ['삼길포', '대천항', '신진도', '오천항', '마검포'];
const YEAR = new Date().getFullYear();
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const input = 'h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15';

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`/api/catch${path}`, { ...init, headers: { 'content-type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `오류 (${res.status})`);
  return body;
}

function Tallies({ title, items }: { title: string; items: Tally }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="mb-2 text-xs font-bold text-muted-foreground">{title}</div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">데이터 없음</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((t) => (
            <span key={t.label} className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
              {t.label} · {t.days}일
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CatchInsights({ onBack }: { onBack: () => void }) {
  const [from, setFrom] = useState(`${YEAR}-09-01`);
  const [to, setTo] = useState(`${YEAR}-11-30`);
  const [port, setPort] = useState('');
  const [top, setTop] = useState(20);
  const [data, setData] = useState<Insights | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ date: todayIso(), port: '삼길포', vessel: '', species: '', count: '', note: '', markedGood: false });
  const [saving, setSaving] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [naverBusy, setNaverBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pastePort, setPastePort] = useState('삼길포');
  const [parsed, setParsed] = useState<Array<{ date: string; port: string; vessel?: string; species: string; count: number | null; note: string; markedGood: boolean }> | null>(null);
  const [parsedSkipped, setParsedSkipped] = useState(0);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams({ from, to, top: String(top) });
      if (port) q.set('port', port);
      const [ins, list] = await Promise.all([call(`/insights?${q}`), call(`/reports?from=${from}&to=${to}`)]);
      setData(ins);
      setReports(list.reports);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [from, to, port, top]);

  useEffect(() => {
    void load();
  }, [load]);

  const collect = async () => {
    setCollecting(true);
    setError('');
    setNotice('');
    try {
      const r = await call('/collect', { method: 'POST', body: '{}' });
      const found = (r.results as Array<{ host: string; postsFound: number; pagesRead: number }>).map((x) => `${x.host.replace('.sunsang24.com', '')} 글 ${x.postsFound}개`).join(', ');
      setNotice(`사이트 조황 ${r.added}건을 새로 가져왔어요${found ? ` (${found})` : ''}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCollecting(false);
    }
  };

  const collectNaver = async () => {
    setNaverBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await call('/collect-naver', { method: 'POST', body: '{}' });
      setNotice(`네이버 글 ${r.items}개를 살펴서 ${r.added}건을 새로 가져왔어요${r.error ? ` (일부 오류: ${r.error})` : ''}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNaverBusy(false);
    }
  };

  const analyze = async () => {
    setError('');
    setNotice('');
    try {
      const r = await call('/parse', { method: 'POST', body: JSON.stringify({ text: pasteText, port: pastePort }) });
      setParsed(r.posts);
      setParsedSkipped(r.skipped);
      if (r.posts.length === 0) setError('날짜를 찾지 못했어요. 글마다 날짜(예: 11/3, 11월 3일)가 들어 있어야 해요');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const saveParsed = async () => {
    if (!parsed?.length) return;
    try {
      const r = await call('/reports/bulk', { method: 'POST', body: JSON.stringify({ items: parsed }) });
      setNotice(`붙여넣은 글에서 ${r.added}건을 저장했어요`);
      setParsed(null);
      setPasteText('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const toggleGood = async (r: Report) => {
    try {
      await call(`/reports/${r.id}/good`, { method: 'PATCH', body: JSON.stringify({ good: !r.markedGood }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await call('/reports', { method: 'POST', body: JSON.stringify({ ...form, count: form.count === '' ? null : Number(form.count) }) });
      setForm((f) => ({ ...f, vessel: '', species: '', count: '', note: '', markedGood: false }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (r: Report) => {
    if (!window.confirm(`${r.date} ${r.port} ${r.vessel || ''} 기록을 삭제할까요?`)) return;
    try {
      await call(`/reports/${r.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 pb-24 pt-5 sm:px-6" data-testid="catch-insights">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="rounded-lg p-1.5 hover:bg-muted" aria-label="뒤로"><ArrowLeft size={18} /></button>
        <Fish size={18} className="text-primary" />
        <h2 className="text-lg font-bold">조황 좋았던 날</h2>
        {loading && <LoaderCircle size={16} className="animate-spin text-muted-foreground" />}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void collect()} disabled={collecting} className="flex h-10 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 text-sm font-semibold text-primary disabled:opacity-50" data-testid="button-collect-site">
          {collecting ? <LoaderCircle size={14} className="animate-spin" /> : <Fish size={14} />}
          사이트 조황 가져오기
        </button>
        <button type="button" onClick={() => void collectNaver()} disabled={naverBusy || collecting} className="flex h-10 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 text-sm font-semibold text-primary disabled:opacity-50" data-testid="button-collect-naver">
          {naverBusy ? <LoaderCircle size={14} className="animate-spin" /> : <Fish size={14} />}
          네이버 글 가져오기
        </button>
        {notice && <span className="text-xs text-muted-foreground" data-testid="collect-notice">{notice}</span>}
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-card p-3 sm:grid-cols-4">
        <label className="text-xs text-muted-foreground">시작<input type="date" className={`${input} mt-1`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-xs text-muted-foreground">끝<input type="date" className={`${input} mt-1`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="text-xs text-muted-foreground">항구
          <select className={`${input} mt-1`} value={port} onChange={(e) => setPort(e.target.value)}>
            <option value="">전체</option>
            {PORTS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">마릿수 상위
          <select className={`${input} mt-1`} value={top} onChange={(e) => setTop(Number(e.target.value))}>
            {[10, 20, 30, 50].map((n) => <option key={n} value={n}>{n}%</option>)}
          </select>
        </label>
      </div>

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-border bg-card p-3"><div className="text-xs text-muted-foreground">기록</div><div className="text-xl font-bold">{data.totalReports}건</div></div>
            <div className="rounded-xl border border-border bg-card p-3"><div className="text-xs text-muted-foreground">조황 좋았던 날</div><div className="text-xl font-bold text-primary">{data.days.length}일</div></div>
          </div>
          {data.days.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-3">
              <Tallies title="좋았던 날의 물때" items={data.byMulddae} />
              <Tallies title="좋았던 날의 조류 세기" items={data.byFlow} />
              <Tallies title="좋았던 날의 항구" items={data.byPort} />
            </div>
          )}

          <div className="space-y-2" data-testid="good-days">
            {data.days.length === 0 && (
              <p className="rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground">
                {data.totalReports === 0 ? '이 기간에 조황 기록이 아직 없어요. 아래에서 기록을 추가해 보세요.' : '이 기간에는 “좋았던 날” 기준에 맞는 기록이 없어요. 상위 비율을 올리거나 기간을 늘려 보세요.'}
              </p>
            )}
            {data.days.map((g) => (
              <div key={`${g.date}|${g.port}`} className="rounded-xl border border-primary/30 bg-card p-3" data-testid={`good-day-${g.date}`}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-base font-bold">{g.date.slice(5).replace('-', '/')} ({g.weekday})</span>
                  <span className="text-sm font-semibold text-primary">{g.port}</span>
                  {g.totalCount !== null && <span className="text-sm text-muted-foreground">{g.totalCount}마리</span>}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-4">
                  <div><span className="text-xs text-muted-foreground">물때 </span>{g.mulddae ?? <span className="text-muted-foreground/70">없음</span>}</div>
                  <div><span className="text-xs text-muted-foreground">조류 </span>{g.flowLabel ?? <span className="text-muted-foreground/70">없음</span>}</div>
                  <div><span className="text-xs text-muted-foreground">날씨 </span>{g.weather ? (g.weather.am === g.weather.pm ? g.weather.am : `${g.weather.am}→${g.weather.pm}`) : <span className="text-muted-foreground/70">없음</span>}</div>
                  <div><span className="text-xs text-muted-foreground">조위차 </span>{g.tideRange !== null ? `${g.tideRange}cm` : <span className="text-muted-foreground/70">없음</span>}</div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {g.reasons.map((r) => <span key={r} className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">{r}</span>)}
                  {g.vessels.map((v) => <span key={v} className="rounded-full bg-muted px-2 py-0.5 text-[11px]">{v}</span>)}
                  {g.species.map((v) => <span key={v} className="rounded-full bg-muted px-2 py-0.5 text-[11px]">{v}</span>)}
                </div>
                {g.tideNote && <p className="mt-1 text-[11px] text-muted-foreground">{g.tideNote}</p>}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="rounded-xl border border-border bg-card p-3">
        <button type="button" onClick={() => setAdding((v) => !v)} className="flex w-full items-center gap-2 text-sm font-bold" data-testid="button-toggle-add-report">
          <Plus size={16} /> 조황 기록 추가 {adding ? '▴' : '▾'}
        </button>
        {adding && (
          <form onSubmit={save} className="mt-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input type="date" className={input} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} data-testid="input-report-date" />
              <select className={input} value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })}>{PORTS.map((p) => <option key={p}>{p}</option>)}</select>
              <input className={input} placeholder="배 이름 (선택)" value={form.vessel} onChange={(e) => setForm({ ...form, vessel: e.target.value })} />
              <input className={input} placeholder="어종 (예: 쭈꾸미)" value={form.species} onChange={(e) => setForm({ ...form, species: e.target.value })} />
              <input className={input} inputMode="numeric" placeholder="마릿수 (선택)" value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value.replace(/\D/g, '') })} data-testid="input-report-count" />
            </div>
            <input className={input} placeholder="메모 (예: 대박, 입질 좋았음)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.markedGood} onChange={(e) => setForm({ ...form, markedGood: e.target.checked })} />조황 좋음으로 표시</label>
            <button type="submit" disabled={saving} className="h-11 rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-50" data-testid="button-save-report">기록 저장</button>
          </form>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-3">
        <button type="button" onClick={() => setPasteOpen((v) => !v)} className="flex w-full items-center gap-2 text-sm font-bold" data-testid="button-toggle-paste">
          <ClipboardPaste size={16} /> 글 붙여넣어서 기록 추가 {pasteOpen ? '▴' : '▾'}
        </button>
        {pasteOpen && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">카페·블로그 조황 글을 복사해서 붙여넣으세요. 글이 여러 개면 한꺼번에 붙여도 되고, 글 사이는 빈 줄이나 날짜로 나뉘어요.</p>
            <select className={input} value={pastePort} onChange={(e) => setPastePort(e.target.value)} aria-label="글에 항구가 없을 때 쓸 항구">
              {PORTS.map((p) => <option key={p} value={p}>항구가 안 적힌 글은 {p}</option>)}
            </select>
            <textarea className="min-h-32 w-full rounded-lg border border-input bg-background p-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" placeholder="여기에 붙여넣기" value={pasteText} onChange={(e) => { setPasteText(e.target.value); setParsed(null); }} data-testid="input-paste-text" />
            <button type="button" onClick={() => void analyze()} disabled={!pasteText.trim()} className="h-11 rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-50" data-testid="button-analyze-paste">글 분석하기</button>
            {parsed && parsed.length > 0 && (
              <div className="space-y-1.5" data-testid="paste-preview">
                <div className="text-xs font-bold text-muted-foreground">{parsed.length}건을 찾았어요{parsedSkipped ? ` (날짜 없는 ${parsedSkipped}개 제외)` : ''}. 틀린 건 x 로 빼고 저장하세요</div>
                {parsed.map((p, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{p.date.slice(5).replace('-', '/')} · {p.port}{p.species ? ` · ${p.species}` : ''}{p.count !== null ? ` · ${p.count}마리` : ' · 마릿수 없음'}</div>
                      <div className="line-clamp-2 text-[11px] text-muted-foreground">{p.note}</div>
                    </div>
                    <button type="button" onClick={() => setParsed((cur) => (cur ? cur.filter((_, k) => k !== i) : cur))} className="rounded-lg border p-1.5" aria-label="빼기"><X size={14} /></button>
                  </div>
                ))}
                <button type="button" onClick={() => void saveParsed()} className="h-11 rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground" data-testid="button-save-paste">{parsed.length}건 저장</button>
              </div>
            )}
          </div>
        )}
      </div>

      {reports.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-sm font-bold">입력한 기록 ({reports.length})</div>
          {reports.map((r) => (
            <div key={r.id} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{r.date.slice(5).replace('-', '/')} · {r.port}{r.vessel ? ` · ${r.vessel}` : ''}{r.species ? ` · ${r.species}` : ''}{r.count !== null ? ` · ${r.count}마리` : ''}</div>
                {(r.note || r.markedGood) && <div className="truncate text-[11px] text-muted-foreground">{r.markedGood ? '★ ' : ''}{r.note}</div>}
              </div>
              <button type="button" onClick={() => void toggleGood(r)} className={`rounded-lg border p-1.5 ${r.markedGood ? 'border-amber-400 bg-amber-100 text-amber-600' : 'text-muted-foreground'}`} aria-label={r.markedGood ? '좋았던 날 표시 해제' : '좋았던 날로 표시'} data-testid={`star-${r.id}`}><Star size={14} fill={r.markedGood ? 'currentColor' : 'none'} /></button>
              <button type="button" onClick={() => remove(r)} className="rounded-lg border p-1.5 text-destructive" aria-label="삭제"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
