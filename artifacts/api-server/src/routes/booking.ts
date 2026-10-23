// routes/booking.ts — 자동 예약 API (테스트 모드)
// 마운트 예: router.use(bookingRouter)  →  /api/booking/...
//
// 보호: Secrets 에 BOOKING_ADMIN_KEY 를 넣으면, 모든 요청이 헤더 x-booking-key 를 보내야 합니다.
//       (화면에서 처음 한 번 입력하면 브라우저에 저장됩니다)

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { getJob, listJobs, startJob, stopJob, validateConfig } from "../lib/booking";

export const bookingRouter = Router();

function guard(req: Request, res: Response, next: NextFunction) {
  const key = process.env.BOOKING_ADMIN_KEY;
  if (key && req.header("x-booking-key") !== key) {
    res.status(401).json({ error: "접근 키가 맞지 않습니다" });
    return;
  }
  next();
}

bookingRouter.get("/booking/status", guard, (_req, res) => {
  res.json({
    mode: "test", // 최종 제출 기능은 아직 없음
    relay: Boolean(process.env.BOOKING_RELAY_URL && process.env.BOOKING_RELAY_TOKEN),
    keyRequired: Boolean(process.env.BOOKING_ADMIN_KEY),
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
    const cfg = validateConfig(req.body);
    res.json({ job: startJob(cfg) });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "요청이 올바르지 않습니다" });
  }
});

bookingRouter.post("/booking/jobs/:id/stop", guard, (req, res) => {
  res.json({ ok: stopJob(String(req.params.id)) });
});

export default bookingRouter;
