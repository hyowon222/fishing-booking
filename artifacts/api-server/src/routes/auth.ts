// routes/auth.ts — 로그인·로그아웃·내 정보, 관리자의 계정 발급
import { Router } from "express";
import {
  adminCreds,
  checkLogin,
  clearFails,
  clearSessionCookie,
  clientKey,
  createUser,
  deleteUser,
  listUsers,
  noteFail,
  sessionFromRequest,
  setSessionCookie,
  tooManyFails,
  updateUser,
} from "../lib/auth";

export const authRouter = Router();

authRouter.get("/auth/me", async (req, res, next) => {
  try {
    const s = await sessionFromRequest(req);
    res.setHeader("cache-control", "no-store");
    res.json({ user: s, configured: Boolean(adminCreds()) });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/auth/login", async (req, res, next) => {
  try {
    const key = clientKey(req);
    if (tooManyFails(key)) {
      res.status(429).json({ error: "로그인을 여러 번 틀렸어요. 10분 뒤에 다시 시도해 주세요" });
      return;
    }
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      res.status(400).json({ error: "아이디와 비밀번호를 입력하세요" });
      return;
    }
    if (!adminCreds()) {
      res.status(503).json({ error: "관리자 계정이 설정되지 않았습니다 (서버 환경변수 ADMIN_USER / ADMIN_PASSWORD)" });
      return;
    }
    const s = await checkLogin(username.trim(), password);
    if (!s) {
      noteFail(key);
      res.status(401).json({ error: "아이디 또는 비밀번호가 맞지 않아요" });
      return;
    }
    clearFails(key);
    setSessionCookie(req, res, s.username);
    res.json({ user: s });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---- 관리자 전용 (검문 단계에서 관리자만 통과)
authRouter.get("/admin/users", async (_req, res, next) => {
  try {
    res.json({ users: await listUsers() });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/admin/users", async (req, res, next) => {
  try {
    const { username, password, canBook } = (req.body ?? {}) as { username?: unknown; password?: unknown; canBook?: unknown };
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "아이디와 비밀번호를 입력하세요" });
      return;
    }
    const err = await createUser(username.trim(), password, canBook === true);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    res.json({ users: await listUsers() });
  } catch (err) {
    next(err);
  }
});

authRouter.patch("/admin/users/:name", async (req, res, next) => {
  try {
    const { password, canBook } = (req.body ?? {}) as { password?: unknown; canBook?: unknown };
    const err = await updateUser(String(req.params.name), {
      password: typeof password === "string" ? password : undefined,
      canBook: typeof canBook === "boolean" ? canBook : undefined,
    });
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    res.json({ users: await listUsers() });
  } catch (err) {
    next(err);
  }
});

authRouter.delete("/admin/users/:name", async (req, res, next) => {
  try {
    await deleteUser(String(req.params.name));
    res.json({ users: await listUsers() });
  } catch (err) {
    next(err);
  }
});
