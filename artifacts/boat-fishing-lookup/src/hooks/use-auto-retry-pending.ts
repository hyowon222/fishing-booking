import { useEffect, useRef } from 'react';

// 서버는 느린 예약처 한 곳 때문에 검색 전체가 오래 멈추지 않도록, 일정 시간이 지나면 응답한
// 예약처의 결과를 먼저 보내면서 경고 문구에 "응답이 늦은 예약처 …"를 담는다. 그런 응답을 받으면
// 늦던 예약처가 서버 백그라운드에서 받아지는 동안 잠깐 기다렸다가 같은 조건으로 자동으로 다시
// 조회해서 결과를 채운다. 무한 반복되지 않게 한 번의 검색당 최대 횟수를 둔다.
// (이 문구는 api-server의 routes/fishing.ts 경고 문구 앞부분과 같아야 한다.)
export const PENDING_SOURCES_NOTICE = '응답이 늦은 예약처';
export const MAX_AUTO_RETRIES = 2;
export const AUTO_RETRY_DELAY_MS = 2500;

type Options = {
  /** "자리 찾기"를 한 번이라도 눌렀는지. 그 전에는 아무것도 하지 않는다. */
  enabled: boolean;
  /** 지금 서버에 조회 중인지. 조회 중에는 다시 조회하지 않는다. */
  isFetching: boolean;
  /** 마지막으로 받은 응답의 경고 문구. */
  warning: string | null | undefined;
  /** 마지막으로 응답을 받은 시각. 새 응답이 올 때마다 바뀐다. */
  dataUpdatedAt: number;
  /** "자리 찾기"를 누를 때마다 바뀌는 값. 바뀌면 자동 재조회 횟수를 처음부터 센다. */
  resetKey: unknown;
  refetch: () => unknown;
};

/**
 * 응답에 "응답이 늦은 예약처"가 있으면 잠시 뒤 같은 조건으로 자동 재조회한다 (검색당 최대
 * MAX_AUTO_RETRIES번). 재조회하는 동안에도 이미 받은 결과는 화면에 그대로 남는다.
 */
export function useAutoRetryWhilePending({
  enabled,
  isFetching,
  warning,
  dataUpdatedAt,
  resetKey,
  refetch,
}: Options): void {
  const retryCount = useRef(0);
  const latestRefetch = useRef(refetch);

  useEffect(() => {
    latestRefetch.current = refetch;
  });

  useEffect(() => {
    retryCount.current = 0;
  }, [resetKey]);

  const hasPending = Boolean(warning?.includes(PENDING_SOURCES_NOTICE));
  useEffect(() => {
    if (!enabled || isFetching || !hasPending) return;
    if (retryCount.current >= MAX_AUTO_RETRIES) return;
    const timer = setTimeout(() => {
      retryCount.current += 1;
      void latestRefetch.current();
    }, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, isFetching, hasPending, dataUpdatedAt]);
}
