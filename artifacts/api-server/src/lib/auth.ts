// lib/auth.ts — 로그인(계정) 처리
//   관리자: 환경변수 ADMIN_USER / ADMIN_PASSWORD (없으면 기존 SITE_AUTH_USER / SITE_AUTH_PASSWORD 를 그대로 사용)
//   일반 계정: 관리자가 화면에서 발급 (DB 의 app_users 표에 비밀번호는 해시로 저장)
//   로그인하면 서명된 쿠키(badajari_session)가 발급되고, 모든 /api 요청에서 확인한다.

import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { pool } from "@workspace/db";

export type Session = { username: string; isAdmin: boolean; canBook: boolean };

const COOKIE = "badajari_session";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function adminCreds(): { user: string; pass: string } | null {
  const user = process.env.ADMIN_USER ?? process.env.SITE_AUTH_USER ?? "";
  const pass = process.env.ADMIN_PASSWORD ?? process.env.SITE_AUTH_PASSWORD ?? "";
  return user && pass ? { user, pass } : null;
}

function secret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const a = adminCreds();
  return crypto.createHash("sha256").update(`badajari|${a?.user ?? ""}|${a?.pass ?? ""}|${process.env.HOME_AGENT_TOKEN ?? ""}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- 비밀번호 해시 (scrypt)
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}
function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const got = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(got, expected);
}

// ---- 계정 표
let tableReady: Promise<void> | null = null;
export function ensureUsersTable(): Promise<void> {
  tableReady ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS app_users (
         username text PRIMARY KEY,
         password_hash text NOT NULL,
         can_book boolean NOT NULL DEFAULT false,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    .then(() => undefined)
    .catch((err) => {
      tableReady = null;
      throw err;
    });
  return tableReady;
}

export type UserRow = { username: string; canBook: boolean; createdAt: string };

export async function listUsers(): Promise<UserRow[]> {
  await ensureUsersTable();
  const r = await pool.query("SELECT username, can_book, created_at FROM app_users ORDER BY created_at");
  return r.rows.map((x) => ({ username: x.username, canBook: x.can_book, createdAt: new Date(x.created_at).toISOString() }));
}

const NAME_RE = /^[\p{L}\p{N}_.-]{2,30}$/u;

export async function createUser(username: string, password: string, canBook: boolean): Promise<string | null> {
  if (!NAME_RE.test(username)) return "아이디는 2~30자의 글자·숫자·_ . - 만 쓸 수 있어요";
  if (password.length < 6 || password.length > 100) return "비밀번호는 6자 이상으로 해 주세요";
  const admin = adminCreds();
  if (admin && username.toLowerCase() === admin.user.toLowerCase()) return "관리자 아이디와 같은 아이디는 쓸 수 없어요";
  await ensureUsersTable();
  const exists = await pool.query("SELECT 1 FROM app_users WHERE lower(username) = lower($1)", [username]);
  if (exists.rowCount) return "이미 있는 아이디예요";
  await pool.query("INSERT INTO app_users (username, password_hash, can_book) VALUES ($1, $2, $3)", [username, hashPassword(password), canBook]);
  return null;
}

export async function updateUser(username: string, patch: { password?: string; canBook?: boolean }): Promise<string | null> {
  await ensureUsersTable();
  if (patch.password !== undefined) {
    if (patch.password.length < 6 || patch.password.length > 100) return "비밀번호는 6자 이상으로 해 주세요";
    await pool.query("UPDATE app_users SET password_hash = $2 WHERE username = $1", [username, hashPassword(patch.password)]);
  }
  if (patch.canBook !== undefined) await pool.query("UPDATE app_users SET can_book = $2 WHERE username = $1", [username, patch.canBook]);
  return null;
}

export async function deleteUser(username: string): Promise<void> {
  await ensureUsersTable();
  await pool.query("DELETE FROM app_users WHERE username = $1", [username]);
}

// ---- 로그인 확인
export async function checkLogin(username: string, password: string): Promise<Session | null> {
  const admin = adminCreds();
  if (admin && safeEqual(username, admin.user) && safeEqual(password, admin.pass)) {
    return { username: admin.user, isAdmin: true, canBook: true };
  }
  await ensureUsersTable();
  const r = await pool.query("SELECT username, password_hash, can_book FROM app_users WHERE lower(username) = lower($1)", [username]);
  const row = r.rows[0];
  // 없는 아이디여도 같은 시간이 걸리게 해시 계산을 한 번 한다
  const ok = verifyPassword(password, row?.password_hash ?? "00:00");
  if (!row || !ok) return null;
  return { username: row.username, isAdmin: false, canBook: row.can_book };
}

// ---- 세션 쿠키
function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}
function makeToken(username: string): string {
  const payload = Buffer.from(JSON.stringify({ u: username, e: Date.now() + MAX_AGE_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function readCookie(req: Request, name: string): string {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

export function setSessionCookie(req: Request, res: Response, username: string) {
  const secure = (req.header("x-forwarded-proto") ?? req.protocol) === "https";
  res.append(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(makeToken(username))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}${secure ? "; Secure" : ""}`,
  );
}
export function clearSessionCookie(res: Response) {
  res.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function sessionFromRequest(req: Request): Promise<Session | null> {
  const token = readCookie(req, COOKIE);
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sign(payload), sig)) return null;
  let data: { u?: string; e?: number };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data.u || !data.e || data.e < Date.now()) return null;
  const admin = adminCreds();
  if (admin && data.u === admin.user) return { username: admin.user, isAdmin: true, canBook: true };
  // 일반 계정은 매번 확인: 삭제된 계정은 바로 로그아웃되고, 권한 변경도 바로 반영된다
  await ensureUsersTable();
  const r = await pool.query("SELECT username, can_book FROM app_users WHERE username = $1", [data.u]);
  const row = r.rows[0];
  return row ? { username: row.username, isAdmin: false, canBook: row.can_book } : null;
}

// ---- 로그인 시도 제한 (같은 주소에서 10분 안에 8번 틀리면 잠시 막는다)
const fails = new Map<string, { n: number; first: number }>();
const WINDOW = 10 * 60 * 1000;
export function clientKey(req: Request): string {
  return (req.header("x-forwarded-for") ?? req.ip ?? "").split(",")[0]!.trim();
}
export function tooManyFails(key: string): boolean {
  const f = fails.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW) {
    fails.delete(key);
    return false;
  }
  return f.n >= 8;
}
export function noteFail(key: string) {
  const f = fails.get(key);
  if (!f || Date.now() - f.first > WINDOW) fails.set(key, { n: 1, first: Date.now() });
  else f.n += 1;
}
export function clearFails(key: string) {
  fails.delete(key);
}

// ---- 모든 /api 요청 검문 (집 PC 중계 주소는 앞에서 따로 처리됨)
const PUBLIC = new Set(["/healthz", "/auth/login", "/auth/logout", "/auth/me"]);

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (PUBLIC.has(req.path)) {
    next();
    return;
  }
  try {
    const s = await sessionFromRequest(req);
    if (!s) {
      res.status(401).json({ error: "로그인이 필요합니다" });
      return;
    }
    const p = req.path;
    if (p.startsWith("/admin") && !s.isAdmin) {
      res.status(403).json({ error: "관리자만 사용할 수 있습니다" });
      return;
    }
    const needBook = p.startsWith("/booking") || p.startsWith("/fishing/sources") || p === "/fishing/diagnostics";
    if (needBook && !s.canBook) {
      res.status(403).json({ error: "권한이 없습니다. 관리자에게 문의하세요" });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
