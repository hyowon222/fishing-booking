// fix-proxy-addr.mjs — 보안 검사에서 막힌 proxy-addr(2.0.7)를 2.0.8로 고정. 저장소 맨 위 폴더에서: node fix-proxy-addr.mjs
import fs from "node:fs";
const ROOT = process.env.ROOT ?? ".";
const ws = `${ROOT}/pnpm-workspace.yaml`;
const pj = `${ROOT}/package.json`;
const KEY = "proxy-addr";
const VAL = "2.0.8";

if (fs.existsSync(ws)) {
  let t = fs.readFileSync(ws, "utf8");
  if (new RegExp(`^\\s+['"]?${KEY}['"]?\\s*:`, "m").test(t)) {
    console.log("이미 proxy-addr 항목이 있습니다. 내용을 확인하세요:\n" + t.split("\n").filter((l) => l.includes(KEY)).join("\n"));
    process.exit(0);
  }
  const lines = t.split("\n");
  const i = lines.findIndex((l) => /^overrides:\s*$/.test(l));
  if (i >= 0) {
    // 기존 overrides 항목의 들여쓰기를 따라감
    const next = lines[i + 1] ?? "";
    const indent = /^(\s+)\S/.exec(next)?.[1] ?? "  ";
    lines.splice(i + 1, 0, `${indent}${KEY}: ${VAL}`);
    t = lines.join("\n");
  } else {
    t = t.replace(/\s*$/, "\n") + `\noverrides:\n  ${KEY}: ${VAL}\n`;
  }
  fs.copyFileSync(ws, "/tmp/pnpm-workspace.yaml.bak-proxy");
  fs.writeFileSync(ws, t);
  console.log("적용: pnpm-workspace.yaml");
} else {
  const j = JSON.parse(fs.readFileSync(pj, "utf8"));
  j.pnpm = j.pnpm ?? {};
  j.pnpm.overrides = { ...(j.pnpm.overrides ?? {}), [KEY]: VAL };
  fs.copyFileSync(pj, "/tmp/package.json.bak-proxy");
  fs.writeFileSync(pj, JSON.stringify(j, null, 2) + "\n");
  console.log("적용: package.json");
}
console.log("이제 pnpm install 을 실행하세요.");
