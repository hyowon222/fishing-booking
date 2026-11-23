import { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, Star, Waves } from 'lucide-react';

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

const NOW = new Date();
const YEARS = [NOW.getFullYear(), NOW.getFullYear() + 1];
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const DEFAULT_PORTS = ['삼길포', '대천항', '신진도', '오천항', '마검포'];
const NO_DATA = '데이터 없음';
// 쭈꾸미·갑오징어 시즌(9~11월)의 "좋은 날" 기준. 값이 없는 날은 별표를 달지 않는다.
//  - 물때: 조류가 너무 센 사리(6~9물)와 너무 약한 조금 전후(13물~2물)를 피한 중간 물때
//  - 조류 세기: 바다타임 물흐름(%)이 너무 약하지도 세지도 않은 구간
const STAR_MONTHS = [9, 10, 11];
const STAR_MULDDAE = [3, 4, 5, 10, 11, 12];
const STAR_FLOW_MIN = 25;
const STAR_FLOW_MAX = 75;

function isStarDay(day: TideDay): boolean {
  const m = /^(\d{1,2})물$/.exec((day.mulddae ?? '').replace(/\s+/g, ''));
  if (!m || !STAR_MULDDAE.includes(Number(m[1]))) return false;
  if (day.flowPercent === null) return false;
  return day.flowPercent >= STAR_FLOW_MIN && day.flowPercent <= STAR_FLOW_MAX;
}

function StarMark() {
  return <Star size={14} className="ml-1 inline-block -translate-y-px fill-amber-400 text-amber-500" aria-label="쭈꾸미·갑오징어 좋은 날" />;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const RANGE_BUCKETS = [
  { key: 'r0', label: '299cm 이하', test: (v: number) => v < 300 },
  { key: 'r3', label: '300~399', test: (v: number) => v >= 300 && v < 400 },
  { key: 'r4', label: '400~499', test: (v: number) => v >= 400 && v < 500 },
  { key: 'r5', label: '500~599', test: (v: number) => v >= 500 && v < 600 },
  { key: 'r6', label: '600cm 이상', test: (v: number) => v >= 600 },
];

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
  const [year, setYear] = useState(NOW.getFullYear());
  const [month, setMonth] = useState(NOW.getMonth() + 1);
  const [data, setData] = useState<TideMonth | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [weekdaySel, setWeekdaySel] = useState<string[]>([]);
  const [rangeSel, setRangeSel] = useState<string[]>([]);
  const [starOnly, setStarOnly] = useState(false);

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
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const allDays = data?.days ?? [];
  const starSeason = STAR_MONTHS.includes(month);
  const starred = (day: TideDay) => starSeason && isStarDay(day);
  const starCount = allDays.filter(starred).length;
  const days = allDays.filter((day) => {
    if (starOnly && starSeason && !starred(day)) return false;
    if (weekdaySel.length > 0 && !weekdaySel.includes(day.weekday)) return false;
    if (rangeSel.length > 0) {
      if (day.range === null) return false;
      const value = day.range;
      if (!RANGE_BUCKETS.some((bucket) => rangeSel.includes(bucket.key) && bucket.test(value))) return false;
    }
    return true;
  });
  const filtered = weekdaySel.length > 0 || rangeSel.length > 0 || (starOnly && starSeason);
  const chip = (active: boolean) =>
    `rounded-full border px-3.5 py-2 text-sm font-semibold transition ${
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
          <div className="flex items-start gap-2" data-testid="tide-month-select">
            <span className="w-12 shrink-0 pt-2 text-xs font-bold text-muted-foreground">월</span>
            <div className="grid flex-1 grid-cols-6 gap-1.5 sm:flex sm:flex-wrap sm:gap-2">
              {MONTHS.map((value) => (
                <button key={value} type="button" onClick={() => setMonth(value)} className={`${chip(month === value)} whitespace-nowrap px-0 text-center text-xs sm:px-3.5 sm:text-sm`}>
                  {value}월
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2" data-testid="tide-weekday-filter">
            <span className="w-12 text-xs font-bold text-muted-foreground">요일</span>
            <button type="button" onClick={() => setWeekdaySel([])} className={chip(weekdaySel.length === 0)} data-testid="weekday-all">
              전체
            </button>
            {WEEKDAYS.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setWeekdaySel((list) => toggle(list, name))}
                className={`${chip(weekdaySel.includes(name))} ${weekdaySel.includes(name) ? '' : weekdayClass(name)}`}
                data-testid={`weekday-${name}`}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2" data-testid="tide-range-filter">
            <span className="w-12 text-xs font-bold text-muted-foreground">고저차</span>
            <button type="button" onClick={() => setRangeSel([])} className={chip(rangeSel.length === 0)} data-testid="range-all">
              전체
            </button>
            {RANGE_BUCKETS.map((bucket) => (
              <button
                key={bucket.key}
                type="button"
                onClick={() => setRangeSel((list) => toggle(list, bucket.key))}
                className={chip(rangeSel.includes(bucket.key))}
                data-testid={`range-${bucket.key}`}
              >
                {bucket.label}
              </button>
            ))}
          </div>
          {starSeason ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="tide-star-filter">
              <span className="w-12 text-xs font-bold text-muted-foreground">추천</span>
              <button type="button" onClick={() => setStarOnly((v) => !v)} className={`${chip(starOnly)} flex items-center gap-1`} data-testid="star-only">
                <Star size={14} className={starOnly ? 'fill-current' : 'fill-amber-400 text-amber-500'} /> 좋은 날만
              </button>
              {data && data.days.length > 0 ? <span className="text-xs text-muted-foreground">이 달 쭈꾸미·갑오징어 좋은 날 <b className="text-foreground">{starCount}일</b></span> : null}
            </div>
          ) : null}
          {filtered && data && data.days.length > 0 ? (
            <div className="flex items-center gap-3 pl-14 text-xs text-muted-foreground" data-testid="tide-filter-summary">
              <span>
                {allDays.length}일 중 <b className="text-foreground">{days.length}일</b> 표시
              </span>
              <button
                type="button"
                onClick={() => {
                  setWeekdaySel([]);
                  setRangeSel([]);
                  setStarOnly(false);
                }}
                className="rounded-lg border border-input px-2.5 py-1 font-semibold hover:bg-muted"
                data-testid="button-filter-reset"
              >
                필터 초기화
              </button>
            </div>
          ) : null}
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
          days.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground" data-testid="tide-filter-empty">
              선택한 조건에 맞는 날이 없습니다.
            </div>
          ) : (
          <>
          <div className="space-y-2 md:hidden" data-testid="tide-cards">
            {days.map((day) => (
              <div key={day.date} className="rounded-xl border border-border bg-card p-3" data-testid={`tide-card-${day.date}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <div className={`text-sm font-bold ${weekdayClass(day.weekday)}`}>
                    {Number(day.date.slice(8, 10))}일({day.weekday})
                    {starred(day) ? <StarMark /> : null}
                    <span className="ml-2 text-[11px] font-normal text-muted-foreground">{day.lunar ? `음력 ${day.lunar}` : ''}</span>
                  </div>
                  <div className="text-sm font-semibold">{day.mulddae ?? <NoData />}</div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <FlowBar day={day} />
                  <span className="mono text-sm">{day.range === null ? '' : `고저차 ${day.range}cm`}</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <div><p className="mb-0.5 text-[11px] font-bold text-muted-foreground">만조</p><EventList events={day.highs} /></div>
                  <div><p className="mb-0.5 text-[11px] font-bold text-muted-foreground">간조</p><EventList events={day.lows} /></div>
                </div>
                {day.weather ? <p className="mt-2 text-xs text-muted-foreground">날씨 {day.weather.am === day.weather.pm ? day.weather.am : `${day.weather.am} / ${day.weather.pm}`}</p> : null}
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-xl border border-border bg-card md:block" data-testid="tide-table">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-xs font-bold text-muted-foreground">
                  <th className="px-3 py-2.5">날짜</th>
                  <th className="px-3 py-2.5">물때</th>
                  <th className="px-3 py-2.5">조류 세기</th>
                  <th className="px-3 py-2.5">만조</th>
                  <th className="px-3 py-2.5">간조</th>
                  <th className="px-3 py-2.5">고저차</th>
                  <th className="px-3 py-2.5">날씨(오전/오후)</th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day.date} className="border-b border-border/70 align-top last:border-b-0" data-testid={`tide-row-${day.date}`}>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <div className={`font-semibold ${weekdayClass(day.weekday)}`}>
                        {Number(day.date.slice(8, 10))}일({day.weekday})
                        {starred(day) ? <StarMark /> : null}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
          )
        )}
        <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
          고저차는 그날 가장 높은 만조와 가장 낮은 간조의 차이입니다. 조류 세기는 바다타임의 물흐름(%) 값입니다. 날씨는 예보가 있는 날짜만 표시됩니다. 값이 없는 달은 아직 바다타임에 올라오지 않은 것입니다.
          {starSeason ? ` ★ 표시는 9~11월 쭈꾸미·갑오징어 좋은 날로, 물때가 ${STAR_MULDDAE.map((n) => `${n}물`).join('·')}이고 조류 세기가 ${STAR_FLOW_MIN}~${STAR_FLOW_MAX}%인 날입니다(조류가 너무 약하거나 센 날은 제외). 물때나 조류 값이 없는 날은 표시하지 않습니다.` : ''}
        </p>
      </section>
    </main>
  );
}
