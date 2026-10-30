// routes/booking.ts — 자동 예약 API (테스트 모드)
// 마운트 예: router.use(bookingRouter)  →  /api/booking/...
//
// 보호: Secrets 에 BOOKING_ADMIN_KEY 를 넣으면, 모든 요청이 헤더 x-booking-key 를 보내야 합니다.
//       (화면에서 처음 한 번 입력하면 브라우저에 저장됩니다)

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { homeAgentStatus } from "../lib/home-agent";
import { getJob, listJobs, normalizeBase, startJobs, stopJob, validateConfigs } from "../lib/booking";
import { detectSource, listConfiguredSources } from "../lib/fishing-source";

export const bookingRouter = Router();

function guard(req: Request, res: Response, next: NextFunction) {
  // 접근 권한은 로그인 검문(lib/auth.ts)에서 이미 확인했다 (예전 접근 키는 더 이상 쓰지 않는다)
  void req;
  void res;
  next();
}

bookingRouter.get("/booking/status", guard, (_req, res) => {
  res.json({
    mode: "test", // 최종 제출 기능은 아직 없음
    relay: Boolean(process.env.BOOKING_RELAY_URL && process.env.BOOKING_RELAY_TOKEN),
    home: homeAgentStatus(),
    keyRequired: false,
  });
});

bookingRouter.get("/booking/jobs", guard, (_req, res) => {
  res.json({ jobs: listJobs() });
});

bookingRouter.get("/booking/jobs/:id", guard, (req, res) => {
  const job = getJob(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: "작업을 찾을 수 없습니다" });
    return;
  }
  res.json({ job });
});

bookingRouter.post("/booking/jobs", guard, (req, res) => {
  try {
    const jobs = startJobs(validateConfigs(req.body));
    res.json({ jobs, job: jobs[0] });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "요청이 올바르지 않습니다" });
  }
});

bookingRouter.post("/booking/jobs/:id/stop", guard, (req, res) => {
  res.json({ ok: stopJob(String(req.params.id)) });
});

// 예약처 주소로 배 목록을 알려 준다: 예약처 관리에 이미 등록된 배가 있으면 그것을, 없으면 사이트를 직접 조회해서 찾는다
bookingRouter.post("/booking/ships", guard, async (req, res) => {
  try {
    const base = normalizeBase(req.body?.url);
    const root = (h: string) => h.replace(/^www\./, "").toLowerCase();
    const host = root(new URL(base).hostname);
    let registered: Awaited<ReturnType<typeof listConfiguredSources>> = [];
    try {
      registered = (await listConfiguredSources()).filter((src) => {
        try {
          return root(new URL(src.sourceUrl).hostname) === host;
        } catch {
          return false;
        }
      });
    } catch {
      /* 등록된 예약처를 읽지 못하면 사이트를 직접 조회한다 */
    }
    const names = [...new Set(registered.flatMap((src) => src.vessels.map((v) => v.name)))];
    if (names.length) {
      res.json({ ships: names, via: "registered" });
      return;
    }
    const found = await detectSource(base);
    res.json({ ships: found?.vessels ?? [], via: "detected", platform: found?.platform ?? "unknown" });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "배 목록을 불러오지 못했습니다" });
  }
});

export default bookingRouter;
