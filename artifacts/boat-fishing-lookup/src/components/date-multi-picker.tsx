import { useState } from 'react';
import { ko } from 'date-fns/locale';
import { CalendarDays } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';

// 여러 날짜를 고르는 달력. 조회 화면의 출항 기간 달력과 같은 모양:
// 폰에서는 아래에서 올라오는 큰 시트, 넓은 화면에서는 말풍선 + 하단 "확인" 막대.
const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromIso = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

export function DateMultiPicker({
  value,
  onChange,
  max = 10,
  title = '출조 날짜',
  testId,
}: {
  value: string[];
  onChange: (dates: string[]) => void;
  max?: number;
  title?: string;
  testId?: string;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Date[]>([]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const openPicker = (next: boolean) => {
    if (next) setPending(value.map(fromIso));
    setOpen(next);
  };
  const confirm = () => {
    onChange(pending.map(toIso).sort());
    setOpen(false);
  };
  const select = (days: Date[] | undefined) => setPending((days ?? []).slice(0, max));

  const button = (
    <button
      type="button"
      onClick={isMobile ? () => openPicker(true) : undefined}
      className="flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 sm:h-10"
      data-testid={testId}
    >
      <span className="truncate">{value.length ? `${value.length}개 날짜 선택됨` : <span className="text-muted-foreground">날짜를 선택해 주세요</span>}</span>
      <CalendarDays size={15} className="shrink-0 text-muted-foreground" />
    </button>
  );
  const bar = (
    <div className="flex items-center justify-between gap-2 border-t border-border p-3">
      <p className="text-xs text-muted-foreground">{pending.length ? `${pending.length}개 선택 (최대 ${max}개)` : '날짜를 눌러 선택하세요'}</p>
      <button
        type="button"
        onClick={confirm}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition sm:px-3 sm:py-1.5 sm:text-xs"
        data-testid={testId ? `${testId}-confirm` : undefined}
      >
        확인
      </button>
    </div>
  );
  const calendar = (big: boolean) => (
    <Calendar
      mode="multiple"
      locale={ko}
      selected={pending}
      onSelect={select}
      defaultMonth={pending[0] ?? today}
      disabled={{ before: today }}
      numberOfMonths={1}
      style={big ? ({ '--cell-size': '2.75rem' } as React.CSSProperties) : undefined}
    />
  );

  if (isMobile) {
    return (
      <>
        {button}
        <Sheet open={open} onOpenChange={(o) => { if (!o) setOpen(false); }}>
          <SheetContent side="bottom" className="rounded-t-2xl px-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-testid={testId ? `${testId}-sheet` : undefined}>
            <SheetHeader className="px-4 text-left">
              <SheetTitle>{title}</SheetTitle>
            </SheetHeader>
            <p className="px-4 pt-1 text-xs text-muted-foreground">원하는 날짜를 모두 눌러요. 다시 누르면 선택이 풀려요.</p>
            <div className="flex justify-center py-2">{calendar(true)}</div>
            {bar}
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={openPicker}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        {calendar(false)}
        {bar}
      </PopoverContent>
    </Popover>
  );
}
