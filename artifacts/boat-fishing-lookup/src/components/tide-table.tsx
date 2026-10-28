import { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, Waves } from 'lucide-react';

type TideEvent = { time: string; height: number | null; delta: number | null };
type TideDay = {
  date: string;
  weekday: string;
  lunar: string | null;
  mulddae: string | null;
  flowPercent: number | null;
  flowLabel: string | null;
  weather: { am: string; pm: string } | null;
  highs: TideEvent[];
  lows: TideEvent[];
  range: number | null;
};
type TideMonth = {
  port: string;
  year: number;
  month: number;
  status: 'ok' | 'unpublished' | 'error';
  message: string | null;
  source: string;
  fetchedAt: string;
  days: TideDay[];
  ports: string[];
};

const YEARS = [2026, 2027];
const MONTHS = [9, 10, 11];
const DEFAULT_PORTS = ['삼길포', '대천항', '신진도', '오천항', '마검포'];
const NO_DATA = '데이터 없음';

function NoData() {
  return <span className="text-xs text-muted-foreground/70">{NO_DATA}</span>;
}

function EventList({ events }: { events: TideEvent[] }) {
  if (events.length === 0) return <NoData />;
  return (
    <div className="space-y-0.5">
      {events.map((event) => (
        <div key={event.time} className="mono whitespace-nowrap text-[13px]">
          <span className="font-semibold">{event.time}</span>
          <span className="ml-1.5 text-muted-foreground">{event.height === null ? '—' : `${event.height}cm`}</span>
        </div>
      ))}
    </div>
  );
}

function FlowBar({ day }: { day: TideDay }) {
  if (day.flowPercent === null) return <NoData />;
  return (
    <div className="relative h-5 w-24 overflow-hidden rounded bg-muted">
      <div className="absolute inset-y-0 left-0 bg-primary/35" style={{ width: `${day.flowPercent}%` }} />
      <span className="absolute inset-0 flex items-center pl-1.5 text-xs font-semibold">{day.flowLabel ?? `${day.flowPercent}%`}</span>
    </div>
  );
}

function weekdayClass(weekday: string) {
  if (weekday === '일') return 'text-red-500';
  if (weekday === '토') return 'text-blue-600';
  return '';
}

export default function TideTable({ onBack }: { onBack: () => void }) {
  const [port, setPort] = useState('삼길포');
  const [year, setYear] = useState(2027);
  const [month, setMonth] = useState(9);
  const [data, setData] = useState<TideMonth | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFetchError('');
    const query = new URLSearchParams({ port, year: String(year), month: String(month) });
    fetch(`/api/fishing/tide-table?${query.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${response.status}`);
        }
        return (await response.json()) as TideMonth;
      })
      .then((result) => setData(result))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setData(null);
        setFetchError(error instanceof Error ? error.message : '물때 정보를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [port, year, month, reloadKey]);

  const ports = data?.ports?.length ? data.ports : DEFAULT_PORTS;
  const chip = (active: boolean) =>
    `rounded-full border px-3.5 py-1.5 text-sm font-semibold transition ${
      active ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-muted'
    }`;

  return (
    <main className="pb-12" data-testid="page-tide-table">
      <section className="mx-auto max-w-[1440px] px-4 pb-4 pt-8 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={onBack}
          className="mb-5 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
          data-testid="button-tide-back"
        >
          <ArrowLeft size={15} /> 돌아가기
        </button>
        <div className="flex items-center gap-2">
          <Waves size={20} className="text-primary" />
          <h1 className="font-serif text-2xl font-bold tracking-tight">서해 물때 정보</h1>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          출처: {data?.source ?? '바다타임(국립해양조사원 자료 기반)'} · 값이 없는 칸은 추정하지 않고 “{NO_DATA}”으로 표시합니다.
        </p>

        <div className="mt-5 space-y-3">
          <div className="flex flex-wrap items-center gap-2" data-testid="tide-port-select">
            <span className="w-12 text-xs font-bold text-muted-foreground">항구</span>
            {ports.map((name) => (
              <button key={name} type="button" onClick={() => setPort(name)} className={chip(port === name)}>
                {name}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2" data-testid="tide-year-select">
            <span className="w-12 text-xs font-bold text-muted-foreground">연도</span>
            {YEARS.map((value) => (
              <button key={value} type="button" onClick={() => setYear(value)} className={chip(year === value)}>
                {value}년
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2" data-testid="tide-month-select">
            <span className="w-12 text-xs font-bold text-muted-foreground">월</span>
            {MONTHS.map((value) => (
              <button key={value} type="button" onClick={() => setMonth(value)} className={chip(month === value)}>
                {value}월
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        {loading ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground" data-testid="tide-loading">
            물때 정보를 불러오는 중…
          </div>
        ) : fetchError || data?.status === 'error' ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center" data-testid="tide-error">
            <p className="text-sm font-semibold">{fetchError || data?.message}</p>
            <button
              type="button"
              onClick={() => setReloadKey((value) => value + 1)}
              className="mx-auto mt-4 flex items-center gap-2 rounded-lg border border-input px-4 py-2 text-sm font-semibold hover:bg-muted"
            >
              <RefreshCw size={14} /> 다시 시도
            </button>
          </div>
        ) : data?.status === 'unpublished' || !data || data.days.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center" data-testid="tide-unpublished">
            <p className="text-sm font-semibold">
              {year}년 {month}월 {port} 물때: {NO_DATA}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">{data?.message ?? '이 달의 물때 정보가 아직 제공되지 않았습니다.'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card" data-testid="tide-table">
            <table className="w-full min-w-[920px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-xs font-bold text-muted-foreground">
                  <th className="px-3 py-2.5">날짜</th>
                  <th className="px-3 py-2.5">물때</th>
                  <th className="px-3 py-2.5">조류 세기</th>
                  <th className="px-3 py-2.5">만조</th>
                  <th className="px-3 py-2.5">간조</th>
                  <th className="px-3 py-2.5">고저차</th>
                  <th className="px-3 py-2.5">날씨(오전/오후)</th>
                  <th className="px-3 py-2.5">바람</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((day) => (
                  <tr key={day.date} className="border-b border-border/70 align-top last:border-b-0" data-testid={`tide-row-${day.date}`}>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <div className={`font-semibold ${weekdayClass(day.weekday)}`}>
                        {Number(day.date.slice(8, 10))}일({day.weekday})
                      </div>
                      <div className="text-[11px] text-muted-foreground">{day.lunar ? `음력 ${day.lunar}` : ''}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-semibold">{day.mulddae ?? <NoData />}</td>
                    <td className="px-3 py-2.5"><FlowBar day={day} /></td>
                    <td className="px-3 py-2.5"><EventList events={day.highs} /></td>
                    <td className="px-3 py-2.5"><EventList events={day.lows} /></td>
                    <td className="mono whitespace-nowrap px-3 py-2.5">{day.range === null ? <NoData /> : `${day.range}cm`}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {day.weather ? (day.weather.am === day.weather.pm ? day.weather.am : `${day.weather.am} / ${day.weather.pm}`) : <NoData />}
                    </td>
                    <td className="px-3 py-2.5"><NoData /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
          고저차는 그날 가장 높은 만조와 가장 낮은 간조의 차이입니다. 조류 세기는 바다타임의 물흐름(%) 값입니다. 날씨는 예보가 있는 날짜만 표시됩니다.
        </p>
      </section>
    </main>
  );
}
