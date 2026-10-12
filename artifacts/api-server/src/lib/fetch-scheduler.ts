/**
 * 예약처 조회(스크래핑)를 "누가 기다리고 있느냐"에 따라 순서를 정해 주는 작은 도구 모음.
 *
 * 배경: 예전에는 서버 전체가 하나의 줄(FIFO)만 썼다. 그래서 페이지를 열 때 같이 도는
 * 필터 목록용 90일치 조회(예약처 15곳 × 4개월 ≈ 60건)가 먼저 줄을 서 있으면, 사용자가
 * 방금 누른 "하루짜리 검색"이 그 뒤에서 한참을 기다려야 했다. 여기서는
 *   - 사용자가 직접 누른 검색("high")은 항상 백그라운드 작업("low")보다 먼저 처리하고,
 *   - 백그라운드 작업이 동시 슬롯을 전부 차지해 검색이 굶지 않도록 일부 슬롯을 남겨 두며,
 *   - 이미 줄 서 있는 백그라운드 요청을 검색이 필요로 하게 되면 앞줄로 올려준다(promote).
 */

export type FetchPriority = "high" | "low";

type Waiter = {
  tag?: string;
  // 슬롯이 배정되는 순간(카운터는 이미 올라간 상태) 대기 중인 호출을 깨운다.
  start: () => void;
};

export type PriorityLimiter = {
  run<T>(task: () => Promise<T>, priority?: FetchPriority, tag?: string): Promise<T>;
  /** 아직 시작 전인 "low" 작업을 tag로 찾아 "high" 줄로 옮긴다. 옮겼으면 true. */
  promote(tag: string): boolean;
  stats(): { active: number; queuedHigh: number; queuedLow: number };
};

export function createPriorityLimiter(options: {
  maxConcurrent: number;
  /** "low" 작업이 쓰지 못하고 항상 비워 두는 슬롯 수 (사용자 검색 전용 여유분). */
  reservedForHigh?: number;
}): PriorityLimiter {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  // 예약분이 전체 이상이면 low 작업이 영영 못 돌기 때문에, 최소 1칸은 low도 쓸 수 있게 한다.
  const reserved = Math.min(Math.max(0, Math.floor(options.reservedForHigh ?? 0)), maxConcurrent - 1);
  const lowLimit = maxConcurrent - reserved;

  let active = 0;
  const high: Waiter[] = [];
  const low: Waiter[] = [];

  // 빈 슬롯이 생길 때마다 호출한다. high를 먼저, low는 예약분을 남기는 범위에서만 시작한다.
  // 카운터(active)를 "깨우는 쪽"에서 즉시 올리는 게 중요하다 — 깨워진 쪽이 나중에
  // 올리면, 그 사이에 다른 호출이 같은 슬롯을 가져가 한도를 넘길 수 있다.
  function pump(): void {
    for (;;) {
      let next: Waiter | undefined;
      if (high.length > 0 && active < maxConcurrent) {
        next = high.shift();
      } else if (low.length > 0 && active < lowLimit) {
        next = low.shift();
      }
      if (!next) return;
      active += 1;
      next.start();
    }
  }

  async function run<T>(task: () => Promise<T>, priority: FetchPriority = "high", tag?: string): Promise<T> {
    const canStartNow = priority === "high" ? active < maxConcurrent : active < lowLimit;
    if (canStartNow) {
      active += 1;
    } else {
      await new Promise<void>((resolve) => {
        (priority === "high" ? high : low).push({ tag, start: resolve });
      });
    }
    try {
      return await task();
    } finally {
      active -= 1;
      pump();
    }
  }

  function promote(tag: string): boolean {
    const index = low.findIndex((waiter) => waiter.tag === tag);
    if (index < 0) return false;
    const [waiter] = low.splice(index, 1);
    high.push(waiter);
    // 예약해 둔 슬롯이 비어 있으면 바로 시작할 수 있다.
    pump();
    return true;
  }

  return {
    run,
    promote,
    stats: () => ({ active, queuedHigh: high.length, queuedLow: low.length }),
  };
}

/** promise가 ms 안에 안 끝나면 reject. 타이머는 끝나는 즉시 정리한다. (원래 promise는 계속 진행됨) */
export function withTimeout<T>(promise: Promise<T>, ms: number, message = "timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 최대 ms만 기다리고, 시간이 지나거나 실패하면 undefined를 돌려준다. (원래 promise는 계속 진행됨) */
export async function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  try {
    return await withTimeout(promise, ms);
  } catch {
    return undefined;
  }
}

/**
 * Promise.allSettled와 비슷하지만 "마감 시각"이 있다.
 *  - 전부 끝나면 즉시 반환.
 *  - softDeadlineMs가 지났는데 아직 안 끝난 게 있으면, 그 시점까지 끝난 것만 담아 반환하고
 *    못 끝난 자리는 undefined로 둔다. (못 끝난 작업은 백그라운드에서 계속 진행된다)
 *  - 다만 마감이 지났는데 성공한 결과가 하나도 없으면, 빈 결과를 내놓는 것보다 낫도록
 *    첫 성공이 나오거나 전부 끝날 때까지는 계속 기다린다.
 */
export function settleWithSoftDeadline<T>(
  promises: ReadonlyArray<Promise<T>>,
  softDeadlineMs?: number,
): Promise<Array<PromiseSettledResult<T> | undefined>> {
  return new Promise((resolve) => {
    const results: Array<PromiseSettledResult<T> | undefined> = new Array(promises.length).fill(undefined);
    let settled = 0;
    let fulfilled = 0;
    let deadlinePassed = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(results.slice());
    };
    const checkDone = () => {
      if (settled === promises.length || (deadlinePassed && fulfilled > 0)) finish();
    };

    if (promises.length === 0) {
      finish();
      return;
    }
    promises.forEach((promise, index) => {
      promise.then(
        (value) => {
          if (finished) return;
          results[index] = { status: "fulfilled", value };
          settled += 1;
          fulfilled += 1;
          checkDone();
        },
        (reason: unknown) => {
          if (finished) return;
          results[index] = { status: "rejected", reason };
          settled += 1;
          checkDone();
        },
      );
    });
    if (!finished && softDeadlineMs !== undefined && softDeadlineMs >= 0) {
      timer = setTimeout(() => {
        deadlinePassed = true;
        checkDone();
      }, softDeadlineMs);
    }
  });
}

/** 환경변수에서 정수를 읽는다. 없거나 잘못된 값/최솟값 미만이면 기본값. */
export function readIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}
