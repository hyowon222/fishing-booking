// routes/catch.ts — 조황 기록과 좋았던 날 모아 보기
import { Router, type IRouter } from "express";
import { addReport, buildInsights, deleteReport, listReports, validateReport } from "../lib/catch-reports";

const router: IRouter = Router();
const DATE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/catch/insights", async (req, res, next) => {
  try {
    const year = new Date().getFullYear();
    const from = typeof req.query.from === "string" && DATE.test(req.query.from) ? req.query.from : `${year}-09-01`;
    const to = typeof req.query.to === "string" && DATE.test(req.query.to) ? req.query.to : `${year}-11-30`;
    const port = typeof req.query.port === "string" && req.query.port ? req.query.port : null;
    const top = Math.min(100, Math.max(1, Number(req.query.top) || 20));
    res.json(await buildInsights(from, to, port, top));
  } catch (err) {
    next(err);
  }
});

router.get("/catch/reports", async (req, res, next) => {
  try {
    const year = new Date().getFullYear();
    const from = typeof req.query.from === "string" && DATE.test(req.query.from) ? req.query.from : `${year}-09-01`;
    const to = typeof req.query.to === "string" && DATE.test(req.query.to) ? req.query.to : `${year}-11-30`;
    res.json({ reports: await listReports(from, to) });
  } catch (err) {
    next(err);
  }
});

router.post("/catch/reports", async (req, res, next) => {
  try {
    const v = validateReport(req.body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    await addReport(v.value, req.header("x-user") ?? "");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/catch/reports/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "잘못된 번호예요" });
      return;
    }
    await deleteReport(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
