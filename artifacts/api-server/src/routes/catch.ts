// routes/catch.ts — 조황 기록과 좋았던 날 모아 보기
import { Router, type IRouter } from "express";
import { naverConfigured, naverJobStatus, startNaverJob } from "../lib/catch-naver";
import { parsePasted } from "../lib/catch-paste";
import { TIDE_PORTS } from "../lib/tide-table";
import { collectCooldown, collectSunsang, markCollectRun } from "../lib/catch-collect";
import { normalizeBase } from "../lib/booking";
import { listConfiguredSources } from "../lib/fishing-source";
import { addReport, buildInsights, deleteReport, listReports, setMarkedGood, validateReport } from "../lib/catch-reports";

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

// 등록된 선상24 예약처의 조황 게시판을 읽어 조황 기록에 넣는다
router.post("/catch/collect", async (req, res, next) => {
  try {
    const wait = collectCooldown();
    if (wait > 0) {
      res.status(429).json({ error: `잠시 후 다시 눌러 주세요 (${Math.ceil(wait / 1000)}초)` });
      return;
    }
    markCollectRun();
    const hosts = new Set<string>();
    try {
      for (const src of await listConfiguredSources()) {
        try {
          const u = new URL(src.sourceUrl);
          if (/sunsang24\.com$/i.test(u.hostname)) hosts.add(`${u.protocol}//${u.hostname}`);
        } catch {
          /* 주소가 이상한 예약처는 건너뛴다 */
        }
      }
    } catch {
      /* 예약처를 못 읽으면 아래 직접 입력 주소만 쓴다 */
    }
    if (typeof req.body?.url === "string" && req.body.url) hosts.add(normalizeBase(req.body.url));
    const since = `${new Date().getFullYear()}-09-01`;
    const results = [];
    for (const h of hosts) results.push(await collectSunsang(h, since, req.header("x-user") ?? ""));
    res.json({ results, added: results.reduce((a, r) => a + r.added, 0) });
  } catch (err) {
    next(err);
  }
});

// 네이버 블로그·카페(공개 글) 검색으로 조황 글을 가져온다 (뒤에서 돌리고 진행 상황은 status 로 본다)
router.post("/catch/collect-naver", (req, res) => {
  if (!naverConfigured()) {
    res.status(400).json({ error: "서버에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 아직 없어요" });
    return;
  }
  const since = `${new Date().getFullYear()}-09-01`;
  const started = startNaverJob(since, req.header("x-user") ?? "");
  res.json({ started, ...naverJobStatus() });
});

router.get("/catch/collect-naver/status", (_req, res) => {
  res.json(naverJobStatus());
});

// 붙여넣은 글을 분석만 한다 (저장은 /catch/reports/bulk)
router.post("/catch/parse", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 60000) : "";
  const port = typeof req.body?.port === "string" && TIDE_PORTS.includes(req.body.port) ? req.body.port : "삼길포";
  if (!text.trim()) {
    res.status(400).json({ error: "붙여넣은 글이 없어요" });
    return;
  }
  res.json(parsePasted(text, port));
});

router.post("/catch/reports/bulk", async (req, res, next) => {
  try {
    const items: unknown[] = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : [];
    let added = 0;
    for (const it of items) {
      const v = validateReport(it);
      if (!v.ok) continue;
      await addReport(v.value, req.header("x-user") ?? "", "paste");
      added++;
    }
    res.json({ ok: true, added });
  } catch (err) {
    next(err);
  }
});

router.patch("/catch/reports/:id/good", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "잘못된 번호예요" });
      return;
    }
    await setMarkedGood(id, req.body?.good === true);
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
