// routes/home-agent.ts — 집 PC 중계 프로그램(home-agent/agent.mjs)이 접속하는 주소
//   GET  /api/home-agent/poll    할 일이 있는지 묻는다 (최대 20초 기다렸다가 응답)
//   POST /api/home-agent/result  사이트에서 받은 결과를 올린다
// 모두 헤더 x-agent-token 이 서버의 HOME_AGENT_TOKEN 과 같아야 한다.

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { deliverResult, homeAgentEnabled, homeAgentToken, requeueJobs, takeJobs, tokenMatches } from "../lib/home-agent";

export const homeAgentRouter = Router();

function agentGuard(req: Request, res: Response, next: NextFunction) {
  if (!homeAgentEnabled()) {
    res.status(404).json({ error: "집 PC 중계가 켜져 있지 않습니다 (HOME_AGENT_TOKEN 없음)" });
    return;
  }
  const given = req.header("x-agent-token") ?? (typeof req.query.t === "string" ? req.query.t : "");
  if (!tokenMatches(given)) {
    res.status(401).json({ error: "토큰이 맞지 않습니다" });
    return;
  }
  next();
}

homeAgentRouter.get("/home-agent/poll", agentGuard, async (req, res) => {
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  const jobs = await takeJobs(() => closed);
  if (closed) {
    // 받아 가기 전에 연결이 끊김 → 요청을 되돌려 다음 접속 때 넘긴다
    requeueJobs(jobs);
    return;
  }
  res.setHeader("cache-control", "no-store");
  res.json({ jobs });
});

homeAgentRouter.post("/home-agent/result", agentGuard, (req, res) => {
  const body = req.body as { id?: unknown; result?: unknown } | undefined;
  if (!body || typeof body.id !== "string") {
    res.status(400).json({ error: "id 가 없습니다" });
    return;
  }
  res.json({ ok: deliverResult(body.id, body.result ?? { error: "upstream", message: "빈 응답" }) });
});

// ---- 집 PC 설치용 파일 (브라우저로 열어 저장하면 된다. 주소 끝에 ?t=토큰 필요)
function findAgentScript(): string | null {
  const roots = [process.cwd(), path.resolve(process.cwd(), ".."), path.resolve(process.cwd(), "../..")];
  for (const root of roots) {
    const file = path.join(root, "home-agent", "agent.mjs");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

homeAgentRouter.get("/home-agent/agent.mjs", agentGuard, (_req, res) => {
  const file = findAgentScript();
  if (!file) {
    res.status(404).send("agent.mjs 를 서버에서 찾지 못했습니다");
    return;
  }
  res.type("text/javascript; charset=utf-8").send(fs.readFileSync(file, "utf8"));
});

homeAgentRouter.get("/home-agent/start.bat", agentGuard, (req, res) => {
  const fromEnv = (process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/+$/, "");
  const host = req.header("x-forwarded-host") ?? req.header("host") ?? "";
  const site = fromEnv || `https://${host}`;
  const user = process.env.SITE_AUTH_USER ?? "";
  const pass = process.env.SITE_AUTH_PASSWORD ?? "";
  const token = homeAgentToken();
  if ([site, user, pass, token].some((v) => /["\r\n]/.test(v))) {
    res.status(500).send("아이디·비밀번호·토큰에 따옴표나 줄바꿈이 있어 설치 파일을 만들 수 없습니다");
    return;
  }
  const esc = (v: string) => v.replace(/%/g, "%%");
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    'cd /d "%~dp0"',
    `set "SITE_URL=${esc(site)}"`,
    `set "HOME_AGENT_TOKEN=${esc(token)}"`,
    `set "SITE_USER=${esc(user)}"`,
    `set "SITE_PASSWORD=${esc(pass)}"`,
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.",
    "  pause",
    "  exit /b 1",
    ")",
    ":loop",
    'curl.exe -s -f -u "%SITE_USER%:%SITE_PASSWORD%" -H "x-agent-token: %HOME_AGENT_TOKEN%" -o agent.new "%SITE_URL%/api/home-agent/agent.mjs"',
    "if exist agent.new move /y agent.new agent.mjs >nul",
    "node agent.mjs",
    "echo Stopped. Restarting in 5 seconds...",
    "timeout /t 5 >nul",
    "goto loop",
    "",
  ];
  res
    .type("application/octet-stream")
    .set("content-disposition", 'attachment; filename="start.bat"')
    .send(lines.join("\r\n"));
});
