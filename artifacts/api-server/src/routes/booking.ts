// routes/booking.ts — 자동 예약 API (테스트 모드)
// 마운트 예: router.use(bookingRouter)  →  /api/booking/...
//
// 보호: Secrets 에 BOOKING_ADMIN_KEY 를 넣으면, 모든 요청이 헤더 x-booking-key 를 보내야 합니다.
//       (화면에서 처음 한 번 입력하면 브라우저에 저장됩니다)

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { homeAgentStatus } from "../lib/home-agent";
import { Session, getJob, listJobs, normalizeBase, startJobs, stopJob, validateConfigs } from "../lib/booking";
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
    let platform = "unknown";
    // 선상24: 달력 페이지에 올라온 배를 전부 읽는다 (자리가 없거나 마감인 배도 목록에는 넣는다)
    if (/sunsang24\.com$/i.test(new URL(base).hostname)) {
      platform = "sunsang24";
      const strip = (t: string) => t.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      const now = new Date();
      for (let k = 0; k < 2; k++) {
        const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
        const month = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
        try {
          const page = await new Session(base).request("GET", `/ship/schedule_fleet/${month}`);
          const marks = [...page.text.matchAll(/<[a-z]+[^>]*class=["'][^"']*\bship_unit\b(?!_)[^"']*["'][^>]*>/g)];
          marks.forEach((m, i) => {
            const chunk = page.text.slice(m.index! + m[0].length, i + 1 < marks.length ? marks[i + 1].index! : page.text.length).slice(0, 4000);
            const name = strip(/class=["']title["'][^>]*>([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? "");
            if (name && name.length <= 30 && !names.includes(name)) names.push(name);
          });
        } catch {
          /* 이 달을 못 읽어도 다른 달·등록된 배로 계속한다 */
        }
      }
    }
    if (names.length) {
      res.json({ ships: names, via: "registered", platform });
      return;
    }
    const found = await detectSource(base);
    res.json({ ships: found?.vessels ?? [], via: "detected", platform: found?.platform ?? "unknown" });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "배 목록을 불러오지 못했습니다" });
  }
});

// 진단: 선상24 예약처의 달력 페이지에서 배가 어떻게 보이는지 보여 준다 (브라우저 주소창에서 열어 본다)
//   /api/booking/ship-debug?url=https://daebak.sunsang24.com&month=202611
bookingRouter.get("/booking/ship-debug", guard, async (req, res) => {
  try {
    const base = normalizeBase(req.query.url);
    const now = new Date();
    const month = typeof req.query.month === "string" && /^\d{6}$/.test(req.query.month) ? req.query.month : `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
    const sess = new Session(base);
    const r = await sess.request("GET", `/ship/schedule_fleet/${month}`);
    const html = r.text;
    const strip = (t: string) => t.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    const days = [...html.matchAll(/id=["']d(\d{4}-\d{2}-\d{2})["']/g)].map((m) => m[1]);
    const marks = [...html.matchAll(/<[a-z]+[^>]*class=["'][^"']*\bship_unit\b[^"']*["'][^>]*>/g)];
    const units = marks.map((m, i) => {
      const chunk = html.slice(m.index! + m[0].length, i + 1 < marks.length ? marks[i + 1].index! : html.length).slice(0, 4000);
      return {
        tag: m[0].slice(0, 160),
        title: strip(/class=["']title["'][^>]*>([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? ""),
        remain: strip(/class=["'][^"']*\bremain\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? "").slice(0, 60),
        status: /data-status_code=["']([A-Z]+)["']/.exec(chunk)?.[1] ?? "",
        scheduleNo: /data-schedule_no=["'](\d+)["']/.exec(chunk)?.[1] ?? "",
      };
    });
    const byTitle: Record<string, number> = {};
    for (const u of units) byTitle[u.title || "(제목없음)"] = (byTitle[u.title || "(제목없음)"] ?? 0) + 1;
    const allTitles = [...new Set([...html.matchAll(/class=["']title["'][^>]*>([\s\S]*?)<\/div>/g)].map((m) => strip(m[1]!)))].slice(0, 60);
    const shipNos = [...new Set([...html.matchAll(/ship_no[_=:"' ]+(\d+)/g)].map((m) => m[1]))].slice(0, 40);
    const names = [...new Set([...html.matchAll(/(뉴항구[^<"'\s]{0,6}|레전드[^<"'\s]{0,6})/g)].map((m) => m[1]))].slice(0, 40);
    res.json({ url: r.url, status: r.status, htmlLength: html.length, pageTitle: strip(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? ""), dayCount: days.length, unitCount: units.length, unitsPerTitle: byTitle, allTitlesOnPage: allTitles, shipNosOnPage: shipNos, nameMentions: names, sampleUnits: units.slice(0, 6) });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

export default bookingRouter;
