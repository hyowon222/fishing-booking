import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ko } from 'date-fns/locale';
import type { DateRange } from 'react-day-picker';
import {
  Anchor,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  Compass,
  Fish,
  Info,
  LifeBuoy,
  MapPin,
  Menu,
  RefreshCw,
  Search,
  Ship,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Waves,
} from 'lucide-react';
import {
  getGetFishingFilterOptionsQueryKey,
  getSearchFishingSchedulesQueryKey,
  useGetFishingFilterOptions,
  useSearchFishingSchedules,
  type FishingFilterOptions,
  type FishingSchedule,
  type SearchFishingSchedulesParams,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import SourceManager from '@/components/source-manager';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

// 기본값(refetchOnWindowFocus 등)을 그대로 두면 탭에 포커스가 돌아올 때마다
// 조용히 모든 예약처를 다시 조회한다. "자리 찾기"를 직접 눌렀을 때만 조회되도록
// 자동 재조회를 모두 끈다.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
    },
  },
});

type Criteria = SearchFishingSchedulesParams;

const pad = (value: number) => String(value).padStart(2, '0');
const toInputDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseInputDate = (value: string) => new Date(`${value}T00:00:00`);
const today = new Date();
const initialCriteria: Criteria = {
  startDate: '',
  endDate: '',
};

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
// getDay()와 동일한 인덱스(0=일요일)로, 백엔드가 원문 사이트에서 파싱해 주는
// weekday 필드("일요일"~"토요일")와 그대로 비교하기 위한 매핑.
const WEEKDAY_FULL_LABELS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

const formatDate = (value: string) => {
  if (!value) return '';
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(
    new Date(value.includes('T') ? value : `${value}T00:00:00`),
  );
};
const formatSearchedAt = (value?: string) =>
  value ? new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';

function FieldLabel({ children, icon: Icon }: { children: ReactNode; icon: typeof CalendarDays }) {
  return (
    <span className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.13em] text-muted-foreground">
      <Icon size={13} strokeWidth={2.2} />
      {children}
    </span>
  );
}

function MultiOption({
  value,
  label,
  checked,
  onChange,
  testId,
  disabled,
}: {
  value: string;
  label: string;
  checked: boolean;
  onChange: (value: string) => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
        disabled
          ? 'cursor-not-allowed opacity-50'
          : checked
            ? 'cursor-pointer bg-primary/10 text-primary'
            : 'cursor-pointer text-foreground hover:bg-muted'
      }`}
    >
      <input
        type="checkbox"
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="peer sr-only"
        data-testid={testId}
      />
      <span
        aria-hidden="true"
        className={`flex h-4 w-4 items-center justify-center rounded-[4px] border transition-colors ${
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card group-hover:border-primary/50'
        }`}
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      <span className="truncate">{label}</span>
    </label>
  );
}

function FilterColumn({
  title,
  values,
  selected,
  onToggle,
  onSelectAll,
  emptyText,
  testPrefix,
  disabled,
  disabledHint,
  layout = 'list',
}: {
  title: string;
  values: string[];
  selected: string[];
  onToggle: (value: string) => void;
  onSelectAll: () => void;
  emptyText: string;
  testPrefix: string;
  disabled?: boolean;
  disabledHint?: string;
  layout?: 'list' | 'grid';
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className={`text-xs font-bold ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}>{title}</span>
        <button
          type="button"
          onClick={disabled ? undefined : onSelectAll}
          disabled={disabled}
          className={`rounded px-1.5 py-0.5 text-[10px] font-bold transition ${
            disabled
              ? 'cursor-not-allowed text-muted-foreground/50'
              : selected.length === 0
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          전체
        </button>
      </div>
      <div
        className={`max-h-40 overflow-y-auto pr-1 ${disabled ? 'opacity-70' : ''} ${
          layout === 'grid' ? 'grid grid-cols-2 gap-x-1 gap-y-0.5 sm:grid-cols-3' : 'space-y-0.5'
        }`}
      >
        {values?.length ? (
          values?.map((value) => (
            <MultiOption
              key={value}
              value={value}
              label={value}
              checked={selected.includes(value)}
              onChange={onToggle}
              testId={`checkbox-${testPrefix}-${value}`}
              disabled={disabled}
            />
          ))
        ) : (
          <p className="py-2 text-xs text-muted-foreground">{disabled && disabledHint ? disabledHint : emptyText}</p>
        )}
      </div>
    </div>
  );
}

function SearchForm({
  criteria,
  setCriteria,
  options,
  isOptionsLoading,
  onSubmit,
  onReset,
  isFetching,
  weekdays,
  setWeekdays,
  onForceRefresh,
  isRefreshingAll,
}: {
  criteria: Criteria;
  setCriteria: (next: Criteria) => void;
  options?: FishingFilterOptions;
  isOptionsLoading: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onReset: () => void;
  isFetching: boolean;
  weekdays: number[];
  setWeekdays: (next: number[]) => void;
  onForceRefresh: () => void;
  isRefreshingAll: boolean;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dateError, setDateError] = useState('');
  const [rangeOpen, setRangeOpen] = useState(false);
  const [pendingRange, setPendingRange] = useState<DateRange | undefined>(
    criteria.startDate && criteria.endDate
      ? { from: parseInputDate(criteria.startDate), to: parseInputDate(criteria.endDate) }
      : undefined,
  );
  const selectedRegions = criteria.region ?? [];
  const selectedShips = criteria.ship ?? [];
  const portSelected = Boolean(criteria.port);
  const regionSelected = selectedRegions.length > 0;
  const shipSelected = selectedShips.length > 0;
  // 항구를 선택하면 지역이, 지역을 선택하면 항구가 잠깁니다. 선박을 하나라도
  // 선택하면 두 조건 모두 잠겨서 지금 보고 있는 선박 기준을 벗어나지 않게 합니다.
  const portDisabled = regionSelected || shipSelected;
  const regionDisabled = portSelected || shipSelected;
  const resolveShips = (port: string | undefined, regions: string[]) => {
    const portShips = port ? options?.shipsByPort?.[port] ?? [] : options?.ships ?? [];
    if (!regions.length) return portShips;
    const regionShips = new Set(regions.flatMap((region) => options?.shipsByRegion?.[region] ?? []));
    return portShips.filter((ship) => regionShips.has(ship));
  };
  const availableShips = resolveShips(criteria.port, selectedRegions);
  const updateList = (key: 'region' | 'ship', value: string) => {
    const current = criteria[key] ?? [];
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    if (key === 'region') {
      // 지역을 선택하면 항구 조건은 비활성화되므로 값도 함께 비워 둡니다.
      const ships = resolveShips(undefined, next);
      setCriteria({ ...criteria, region: next, port: undefined, ship: (criteria.ship ?? []).filter((ship) => ships.includes(ship)) });
      return;
    }
    setCriteria({ ...criteria, ship: next });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!criteria.startDate || !criteria.endDate) {
      setDateError('출항 기간을 선택해 주세요.');
      return;
    }
    if (criteria.startDate > criteria.endDate) {
      setDateError('출항 시작일은 종료일보다 빠르거나 같아야 합니다.');
      return;
    }
    setDateError('');
    onSubmit(event);
  };
  const toggleWeekday = (day: number) => {
    setWeekdays(weekdays.includes(day) ? weekdays.filter((item) => item !== day) : [...weekdays, day].sort());
  };
  const clearAll = () => {
    setDateError('');
    setPendingRange(undefined);
    setWeekdays([]);
    onReset();
  };
  const openRangePicker = (open: boolean) => {
    if (open) {
      // 열 때마다 이전에 확정한 기간을 그대로 보여주되, 아직 아무 기간도
      // 고르지 않았다면(기본값 없음) 빈 상태로 열어서 직접 시작일부터 고르게 한다.
      setPendingRange(
        criteria.startDate && criteria.endDate
          ? { from: parseInputDate(criteria.startDate), to: parseInputDate(criteria.endDate) }
          : undefined,
      );
    }
    setRangeOpen(open);
  };
  const confirmRange = () => {
    if (!pendingRange?.from) return;
    const from = pendingRange.from;
    const to = pendingRange.to ?? from;
    setCriteria({ ...criteria, startDate: toInputDate(from), endDate: toInputDate(to) });
    setRangeOpen(false);
  };

  return (
    <section className="relative z-10 mx-auto max-w-[1440px] px-4 pb-5 sm:px-6 lg:px-8">
      <form onSubmit={submit} className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_14px_45px_hsl(214_42%_18%_/_0.08)]">
        <div className="flex items-center justify-between border-b border-border bg-muted/35 px-4 py-3 sm:px-5">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={16} className="text-primary" />
            <h2 className="text-sm font-bold tracking-tight">검색 조건</h2>
            <span className="hidden rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary sm:inline">OPEN SEAT RADAR</span>
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen((open) => !open)}
            className="flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground sm:hidden"
            data-testid="button-toggle-filters"
          >
            {mobileOpen ? '접기' : '필터 열기'}
            <ChevronDown className={`transition-transform ${mobileOpen ? 'rotate-180' : ''}`} size={15} />
          </button>
        </div>

        <div className={`${mobileOpen ? 'block' : 'hidden'} space-y-5 p-4 sm:block sm:p-5`}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1.25fr_1.25fr_1fr_1fr]">
            <div>
              <FieldLabel icon={CalendarDays}>출항 기간</FieldLabel>
              <Popover open={rangeOpen} onOpenChange={openRangePicker}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                    data-testid="button-date-range"
                  >
                    <span className="truncate">
                      {criteria.startDate && criteria.endDate ? (
                        `${formatDate(criteria.startDate)} — ${formatDate(criteria.endDate)}`
                      ) : (
                        <span className="text-muted-foreground">출항 기간을 선택해 주세요</span>
                      )}
                    </span>
                    <CalendarDays size={15} className="shrink-0 text-muted-foreground" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto p-0">
                  <Calendar
                    mode="range"
                    locale={ko}
                    selected={pendingRange}
                    onSelect={setPendingRange}
                    defaultMonth={pendingRange?.from ?? today}
                    numberOfMonths={1}
                  />
                  <div className="flex items-center justify-between gap-2 border-t border-border p-3">
                    <p className="text-xs text-muted-foreground">
                      {pendingRange?.from
                        ? `${formatDate(toInputDate(pendingRange.from))} — ${formatDate(toInputDate(pendingRange.to ?? pendingRange.from))}`
                        : '날짜를 선택하세요'}
                    </p>
                    <button
                      type="button"
                      onClick={confirmRange}
                      disabled={!pendingRange?.from}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground transition disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid="button-confirm-date-range"
                    >
                      확인
                    </button>
                  </div>
                </PopoverContent>
              </Popover>
              <p className="mt-1.5 text-[11px] text-muted-foreground">하루만 이용하시려면 같은 날짜를 두 번 선택한 뒤 확인을 눌러주세요.</p>
              {dateError && <p className="mt-1.5 flex items-center gap-1 text-xs text-destructive"><CircleAlert size={12} />{dateError}</p>}
            </div>
            <div>
              <FieldLabel icon={MapPin}>출항 항구</FieldLabel>
              <select
                value={criteria.port ?? ''}
                disabled={portDisabled}
                 onChange={(event) => {
                   const port = event.target.value || undefined;
                   // 항구를 선택하면 지역 조건은 비활성화되므로 값도 함께 비웁니다.
                   const ships = resolveShips(port, []);
                   setCriteria({ ...criteria, port, region: [], ship: (criteria.ship ?? []).filter((ship) => ships.includes(ship)) });
                 }}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="select-port"
              >
                <option value="">전체 항구</option>
                {options?.ports?.map((port) => <option value={port} key={port}>{port}</option>)}
              </select>
              {portDisabled && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {shipSelected ? '선박 선택을 해제하면 다시 고를 수 있어요.' : '지역 선택을 해제하면 다시 고를 수 있어요.'}
                </p>
              )}
            </div>
            <FilterColumn
              title="지역"
              values={options?.regions ?? []}
               selected={selectedRegions}
              onToggle={(value) => updateList('region', value)}
               onSelectAll={() => setCriteria({ ...criteria, region: [], ship: (criteria.ship ?? []).filter((ship) => resolveShips(criteria.port, []).includes(ship)) })}
              emptyText={isOptionsLoading ? '목록 불러오는 중' : '사용 가능한 지역 없음'}
              testPrefix="region"
              disabled={regionDisabled}
              disabledHint={shipSelected ? '선박 선택을 해제하면 다시 고를 수 있어요.' : '항구 선택을 해제하면 다시 고를 수 있어요.'}
              layout="grid"
            />
            <FilterColumn
              title="선박"
               values={availableShips}
              selected={criteria.ship ?? []}
              onToggle={(value) => updateList('ship', value)}
               onSelectAll={() => setCriteria({ ...criteria, ship: [] })}
              emptyText={isOptionsLoading ? '목록 불러오는 중' : '사용 가능한 선박 없음'}
              testPrefix="ship"
            />
          </div>

          <div className="border-t border-border pt-4">
            <FieldLabel icon={CalendarDays}>요일</FieldLabel>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setWeekdays([])}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  weekdays.length === 0 ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background hover:border-primary/50'
                }`}
                data-testid="button-weekday-all"
              >전체</button>
              {WEEKDAY_LABELS.map((label, day) => (
                <button
                  type="button"
                  key={label}
                  onClick={() => toggleWeekday(day)}
                  className={`h-8 w-8 rounded-full border text-xs font-bold transition ${
                    weekdays.includes(day)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : day === 0
                        ? 'border-input bg-background text-destructive hover:border-primary/50'
                        : day === 6
                          ? 'border-input bg-background text-[hsl(210_70%_45%)] hover:border-primary/50'
                          : 'border-input bg-background hover:border-primary/50'
                  }`}
                  data-testid={`button-weekday-${day}`}
                >{label}</button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">기간을 넓게 잡고 특정 요일만 골라 잔여석을 확인할 수 있어요.</p>
          </div>

          <div className="flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0 flex-1">
              <FieldLabel icon={Waves}>물때</FieldLabel>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setCriteria({ ...criteria, tide: undefined })}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    !criteria.tide ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background hover:border-primary/50'
                  }`}
                  data-testid="button-tide-all"
                >전체</button>
                {(options?.tides ?? [])?.map((tide) => (
                  <button
                    type="button"
                    key={tide}
                    onClick={() => setCriteria({ ...criteria, tide: criteria.tide === tide ? undefined : tide })}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      criteria.tide === tide ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background hover:border-primary/50'
                    }`}
                    data-testid={`button-tide-${tide}`}
                  >{tide}</button>
                ))}
                {isOptionsLoading && <span className="text-xs text-muted-foreground">물때 목록을 불러오는 중입니다.</span>}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={onForceRefresh}
                disabled={isRefreshingAll}
                title="캐시를 비우고 모든 예약처를 처음부터 다시 조회합니다"
                className="flex h-10 items-center justify-center gap-1.5 rounded-lg border border-input px-4 text-sm font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-70"
                data-testid="button-force-refresh"
              >
                <RefreshCw size={14} className={isRefreshingAll ? 'animate-spin' : undefined} />
                {isRefreshingAll ? '전체 조회 중' : '전체 다시 조회'}
              </button>
              <button type="button" onClick={clearAll} className="flex h-10 items-center justify-center gap-1.5 rounded-lg border border-input px-4 text-sm font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground" data-testid="button-reset-filters">
                <RefreshCw size={14} /> 초기화
              </button>
              <button type="submit" className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground shadow-sm transition hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 disabled:cursor-wait disabled:opacity-70" disabled={isFetching} data-testid="button-search-schedules">
                {isFetching ? <RefreshCw size={15} className="animate-spin" /> : <Search size={15} />}
                {isFetching ? '찾는 중' : '자리 찾기'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}

function LoadingTable() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="hidden grid-cols-[1.1fr_.9fr_1fr_1.1fr_.85fr_1fr_110px] gap-4 border-b border-border bg-muted/40 px-5 py-3 md:grid">
        {[80, 70, 75, 86, 70, 70, 56].map((width, index) => <div key={index} className="skeleton-shimmer h-3 rounded" style={{ width }} />)}
      </div>
      {[1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="flex flex-col gap-3 border-b border-border p-4 last:border-0 md:grid md:grid-cols-[1.1fr_.9fr_1fr_1.1fr_.85fr_1fr_110px] md:items-center md:gap-4 md:px-5">
          {[100, 65, 80, 120, 45, 78, 68].map((width, index) => <div key={index} className={`${index > 0 ? 'hidden md:block' : ''} skeleton-shimmer h-4 rounded`} style={{ width }} />)}
        </div>
      ))}
    </div>
  );
}

function ScheduleRow({ schedule }: { schedule: FishingSchedule }) {
  const seatState = schedule.remainingSeats === null ? '확인 필요' : schedule.remainingSeats === 0 ? '마감' : `${schedule.remainingSeats}석`;
  const seatClass = schedule.remainingSeats === null ? 'bg-muted text-muted-foreground' : schedule.remainingSeats === 0 ? 'bg-destructive/10 text-destructive' : schedule.remainingSeats <= 3 ? 'bg-accent/20 text-[#966516]' : 'bg-primary/10 text-primary';
  return (
    <div className="group grid gap-2 border-b border-border px-4 py-4 transition-colors last:border-0 hover:bg-muted/35 md:grid-cols-[1.1fr_.9fr_1fr_1.1fr_.85fr_1fr_110px] md:items-center md:gap-4 md:px-5" data-testid={`row-schedule-${schedule.id}`}>
      <div className="flex items-start justify-between md:block">
        <div>
          <p className="text-sm font-bold">{formatDate(schedule.departureDate)} <span className="font-medium text-muted-foreground">{schedule.weekday}</span></p>
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><MapPin size={12} />{schedule.port}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold md:hidden ${seatClass}`}>{seatState}</span>
      </div>
      <div className="flex items-center gap-2 text-sm"><span className="text-xs text-muted-foreground md:hidden">지역</span><span>{schedule.region}</span></div>
      <div className="flex items-center gap-2 text-sm"><span className="text-xs text-muted-foreground md:hidden">선박</span><span className="font-semibold">{schedule.vessel}</span></div>
      <div className="flex min-w-0 items-center gap-2 text-sm"><span className="text-xs text-muted-foreground md:hidden">운영사</span>{schedule.operatorUrl ? <a href={schedule.operatorUrl} target="_blank" rel="noreferrer" className="truncate font-medium hover:text-primary hover:underline">{schedule.operator}</a> : <span className="truncate">{schedule.operator}</span>}</div>
      <div className="flex items-center gap-2 text-sm"><span className="text-xs text-muted-foreground md:hidden">장르</span><span className="rounded-md bg-secondary px-2 py-1 text-xs font-semibold text-secondary-foreground">{schedule.genre}</span></div>
      <div className="flex items-center gap-2 text-sm"><span className="text-xs text-muted-foreground md:hidden">물때</span><span>{schedule.tide}</span></div>
      <div className="flex items-center justify-between gap-2 pt-2 md:justify-end md:pt-0">
        <span className={`hidden rounded-full px-2.5 py-1 text-xs font-bold md:inline-flex ${seatClass}`}>{seatState}</span>
        {schedule.bookingUrl && schedule.remainingSeats !== 0 ? (
          <a href={schedule.bookingUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs font-bold text-primary opacity-100 transition group-hover:translate-x-0.5 hover:underline md:opacity-0 md:group-hover:opacity-100" data-testid={`link-book-${schedule.id}`}>
            예약 <ArrowUpRight size={13} />
          </a>
        ) : <span className="text-[11px] text-muted-foreground md:hidden">{schedule.source}</span>}
      </div>
    </div>
  );
}

function ScheduleResults({
  data,
  isLoading,
  isError,
  hasSearched,
  onRetry,
}: {
  data?: { items: FishingSchedule[]; total: number; searchedAt: string; source: string; cachedUntil: string | null; warning: string | null };
  isLoading: boolean;
  isError: boolean;
  hasSearched: boolean;
  onRetry: () => void;
}) {
  if (!hasSearched) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card px-6 py-20 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Search size={25} /></div>
        <h3 className="font-bold">검색 조건을 설정해 주세요</h3>
        <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">기간과 항구·지역·선박 조건을 정한 뒤 '자리 찾기'를 누르면 출항 일정을 조회합니다.</p>
      </div>
    );
  }
  if (isLoading) return <LoadingTable />;
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-destructive/25 bg-card px-6 py-16 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"><CircleAlert size={22} /></div>
        <h3 className="font-bold">일정을 불러오지 못했습니다</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">예약처 연결이 잠시 불안정합니다. 같은 조건으로 다시 시도해 주세요.</p>
        <button onClick={onRetry} className="mt-5 flex items-center gap-2 rounded-lg border border-input px-4 py-2 text-sm font-semibold hover:bg-muted" data-testid="button-retry-search"><RefreshCw size={14} /> 다시 시도</button>
      </div>
    );
  }
  if (!data?.items?.length) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card px-6 py-20 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Compass size={25} /></div>
        <h3 className="font-bold">조건에 맞는 배가 없습니다</h3>
        <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">기간을 넓히거나 지역·선박 필터를 하나씩 해제하면 더 많은 출항을 확인할 수 있습니다.</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_8px_30px_hsl(214_42%_18%_/_0.04)]">
      {data.warning && <div className="flex items-start gap-2 border-b border-accent/30 bg-accent/10 px-4 py-3 text-xs leading-5 text-[#765019]"><Info size={15} className="mt-0.5 shrink-0" />{data.warning}</div>}
      <div className="hidden grid-cols-[1.1fr_.9fr_1fr_1.1fr_.85fr_1fr_110px] gap-4 border-b border-border bg-muted/40 px-5 py-3 text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground md:grid">
        <span>출항일</span><span>지역</span><span>선박</span><span>운영사</span><span>장르</span><span>물때</span><span className="text-right">잔여</span>
      </div>
      {data.items?.map((schedule) => <ScheduleRow schedule={schedule} key={schedule.id} />)}
    </div>
  );
}

function Home() {
  const [criteria, setCriteria] = useState<Criteria>(initialCriteria);
  const [appliedParams, setAppliedParams] = useState<Criteria>(initialCriteria);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [appliedWeekdays, setAppliedWeekdays] = useState<number[]>([]);
  const [showSourceManager, setShowSourceManager] = useState(false);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  // 사이트 진입 시 자동으로 일정을 조회하지 않고, "자리 찾기"를 눌렀을 때만 조회합니다.
  const [hasSearched, setHasSearched] = useState(false);
  const optionsQuery = useGetFishingFilterOptions({ query: { queryKey: getGetFishingFilterOptionsQueryKey() } });
  const searchQuery = useSearchFishingSchedules(appliedParams, {
    query: { queryKey: getSearchFishingSchedulesQueryKey(appliedParams), retry: 1, enabled: hasSearched },
  });
  const options = optionsQuery.data;
  // 요일 필터는 서버에 보내지 않고, 이미 받아온 기간 전체 결과에서 화면에
  // 표시하기 직전에만 걸러낸다 (기간을 넓게 잡고 특정 요일만 보고 싶을 때 사용).
  // item.departureDate를 브라우저에서 다시 Date로 파싱해 getDay()를 구하면
  // 브라우저 시간대/파싱 방식에 따라 어긋날 수 있으므로, 백엔드가 원문 사이트에서
  // 직접 읽어온 정확한 요일 텍스트(item.weekday, 예: "토요일")로 비교한다.
  const data = useMemo(() => {
    const raw = searchQuery.data;
    if (!raw || appliedWeekdays.length === 0) return raw;
    const selectedLabels = new Set(appliedWeekdays.map((day) => WEEKDAY_FULL_LABELS[day]));
    const items = raw.items.filter((item) => selectedLabels.has(item.weekday));
    return { ...raw, items, total: items.length };
  }, [searchQuery.data, appliedWeekdays]);
  const activeFilterCount =
    (criteria.region?.length ?? 0) + (criteria.ship?.length ?? 0) + (criteria.port ? 1 : 0) + (criteria.tide ? 1 : 0) + (weekdays.length ? 1 : 0);
  const rangeLabel = useMemo(
    () => (appliedParams.startDate && appliedParams.endDate ? `${formatDate(appliedParams.startDate)} — ${formatDate(appliedParams.endDate)}` : '기간 미선택'),
    [appliedParams.endDate, appliedParams.startDate],
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedParams({ ...criteria });
    setAppliedWeekdays(weekdays);
    setHasSearched(true);
  };
  const reset = () => {
    setCriteria(initialCriteria);
    setAppliedParams(initialCriteria);
    setWeekdays([]);
    setAppliedWeekdays([]);
    setHasSearched(false);
  };
  // 서버의 캐시(5분 유지)를 비우고, 모든 예약처를 처음부터 다시 스크래핑하도록 강제한다.
  const forceRefreshAll = async () => {
    setIsRefreshingAll(true);
    try {
      await fetch('/api/fishing/cache/refresh', { method: 'POST' });
      await Promise.all([optionsQuery.refetch(), hasSearched ? searchQuery.refetch() : Promise.resolve()]);
    } finally {
      setIsRefreshingAll(false);
    }
  };

  return (
    <div className="noise-layer app-shell min-h-[100dvh] text-foreground">
      <header className="border-b border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground shadow-[0_8px_22px_hsl(166_66%_47%_/_0.2)]">
              <Anchor size={20} strokeWidth={2.3} />
              <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-sidebar bg-accent" />
            </div>
            <div>
              <div className="flex items-center gap-2"><span className="font-serif text-lg font-bold tracking-tight">바다자리</span><span className="rounded-sm border border-sidebar-border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.14em] text-sidebar-primary">DESK</span></div>
              <p className="hidden text-[10px] tracking-[0.16em] text-sidebar-foreground/55 sm:block">COASTAL SEAT INTELLIGENCE</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-sidebar-foreground/65">
            <div className="hidden items-center gap-2 md:flex"><span className="h-1.5 w-1.5 rounded-full bg-sidebar-primary" />실시간 예약처 연결됨</div>
            <button onClick={() => setShowSourceManager(true)} className="rounded-lg p-2 hover:bg-sidebar-accent md:hidden" data-testid="button-mobile-menu" aria-label="예약처 관리"><Menu size={18} /></button>
            <div className="hidden h-8 w-px bg-sidebar-border sm:block" />
            <button type="button" onClick={() => setShowSourceManager(true)} className="hidden items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-sidebar-accent sm:flex" data-testid="button-manage-sources"><Settings2 size={15} />예약처 관리</button>
          </div>
        </div>
      </header>

      {showSourceManager ? (
        <SourceManager onBack={() => setShowSourceManager(false)} />
      ) : (
      <main className="pb-12">
        <section className="mx-auto max-w-[1440px] px-4 pb-7 pt-8 sm:px-6 sm:pt-10 lg:px-8">
          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <div className="screen-reveal">
              <div className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary"><span className="h-px w-6 bg-primary" />Open seat radar</div>
              <h1 className="max-w-2xl font-serif text-[clamp(2rem,4.5vw,3.8rem)] font-bold leading-[1.02] tracking-[-0.045em]">이번 출항,<br /><span className="text-primary">탈 수 있는 자리</span>부터.</h1>
              <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">흩어진 예약처를 한 번에 살펴보고, 실제로 예약할 가치가 있는 출항만 빠르게 비교하세요.</p>
            </div>
            <div className="screen-reveal-delay flex items-center gap-3 md:pb-1">
              <div className="rounded-xl border border-border bg-card px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">Last checked</p>
                <p className="mono mt-1 text-sm font-medium">{formatSearchedAt(data?.searchedAt)}</p>
              </div>
              <div className="rounded-xl border border-border bg-card px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">Source</p>
                <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold"><span className="h-1.5 w-1.5 rounded-full bg-primary" />{data?.source ?? '연결 대기'}</p>
              </div>
            </div>
          </div>
        </section>

        <SearchForm criteria={criteria} setCriteria={setCriteria} options={options} isOptionsLoading={optionsQuery.isLoading} onSubmit={submit} onReset={reset} isFetching={searchQuery.isFetching} weekdays={weekdays} setWeekdays={setWeekdays} onForceRefresh={forceRefreshAll} isRefreshingAll={isRefreshingAll} />

        <section className="mx-auto max-w-[1440px] px-4 pt-2 sm:px-6 lg:px-8">
          <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-serif text-xl font-bold tracking-tight">출항 일정</h2>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary" data-testid="text-result-count">{!hasSearched || searchQuery.isLoading ? '—' : `${data?.total ?? 0}건`}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground"><CalendarDays size={12} className="mr-1 inline" />{rangeLabel} · {activeFilterCount ? `필터 ${activeFilterCount}개 적용` : '전체 조건'} </p>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><Sparkles size={13} className="text-accent-foreground" /> 잔여 좌석 기준 정렬</span>
              {data?.cachedUntil && <span className="hidden items-center gap-1.5 sm:flex"><RefreshCw size={12} /> {formatSearchedAt(data.cachedUntil)}까지 캐시</span>}
            </div>
          </div>
          <ScheduleResults data={data} isLoading={hasSearched && searchQuery.isLoading} isError={hasSearched && searchQuery.isError} hasSearched={hasSearched} onRetry={() => searchQuery.refetch()} />
        </section>
      </main>
      )}
      <footer className="border-t border-border bg-card/60">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-2 px-4 py-5 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p className="flex items-center gap-1.5"><Fish size={13} />바다자리 · 출항 정보는 각 운영사 예약처를 기준으로 합니다.</p>
          <p className="flex items-center gap-1.5"><Ship size={13} />마지막 확인 시각을 꼭 확인하세요.</p>
        </div>
      </footer>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
