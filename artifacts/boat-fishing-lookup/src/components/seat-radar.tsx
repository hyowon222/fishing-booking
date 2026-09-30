import { useEffect, useState } from 'react';
import { Anchor } from 'lucide-react';

// 헤더의 "Open seat radar" 컨셉을 그대로 로딩 화면으로 가져온 컴포넌트.
// 등록된 예약처를 하나씩 훑어보는 과정을 레이더 스캔 애니메이션으로 표현한다.

const SCAN_MESSAGES = [
  '예약처에 연결하는 중',
  '출항 일정을 확인하는 중',
  '잔여 좌석을 계산하는 중',
  '결과를 정리하는 중',
];

// 스윕이 지나갈 때 반짝이는 "탐지 블립" 위치(각도·반지름)를 고정값으로 미리
// 정해 둔다. 렌더마다 랜덤으로 만들면 리렌더 시 위치가 튀어 보인다.
const BLIPS = [
  { angle: 35, radius: 62, delay: '0s' },
  { angle: 120, radius: 40, delay: '.9s' },
  { angle: 200, radius: 70, delay: '1.7s' },
  { angle: 262, radius: 50, delay: '.4s' },
  { angle: 308, radius: 30, delay: '2.3s' },
];

function polarToXY(angleDeg: number, radius: number, center = 100) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: center + radius * Math.cos(rad), y: center + radius * Math.sin(rad) };
}

export function SeatRadar() {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setMessageIndex((current) => (current + 1) % SCAN_MESSAGES.length);
    }, 1800);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className="flex flex-col items-center justify-center gap-6 rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center"
      role="status"
      aria-label="출항 일정을 검색하는 중입니다. 잠시만 기다려 주세요."
      data-testid="loading-seat-radar"
    >
      <div className="radar-scope" aria-hidden="true">
        <svg viewBox="0 0 200 200" className="radar-svg">
          <circle cx="100" cy="100" r="88" className="radar-ring" />
          <circle cx="100" cy="100" r="58" className="radar-ring" />
          <circle cx="100" cy="100" r="28" className="radar-ring" />
          <line x1="12" y1="100" x2="188" y2="100" className="radar-crosshair" />
          <line x1="100" y1="12" x2="100" y2="188" className="radar-crosshair" />
          {BLIPS.map((blip, index) => {
            const { x, y } = polarToXY(blip.angle, blip.radius);
            return (
              <circle
                key={index}
                cx={x}
                cy={y}
                r="4"
                className="radar-blip"
                style={{ animationDelay: blip.delay }}
              />
            );
          })}
        </svg>
        <div className="radar-sweep" />
        <div className="radar-center">
          <Anchor size={20} strokeWidth={2.3} />
        </div>
      </div>
      <div aria-hidden="true">
        <p className="flex items-center justify-center font-serif text-base font-bold" data-testid="text-radar-message">
          {SCAN_MESSAGES[messageIndex]}
          <span className="radar-ellipsis">
            <span />
            <span />
            <span />
          </span>
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">등록된 예약처를 하나씩 훑어보는 중입니다.</p>
      </div>
    </div>
  );
}
