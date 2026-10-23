// apply-booking.mjs — "자동 예약" 메뉴 연결 (서버 라우터 + 화면). 저장소 맨 위 폴더에서: node apply-booking.mjs
// 각 수정은 "정확히 1곳"을 찾을 때만 적용하고, 하나라도 못 찾으면 아무것도 바꾸지 않습니다. 원본은 /tmp/*.bak-booking 에 백업합니다.
import fs from "node:fs";

const ROOT = process.env.ROOT ?? ".";
const files = [
  {
    path: `${ROOT}/artifacts/api-server/src/routes/index.ts`,
    edits: [
      [`import fishingRouter from "./fishing";`, `import fishingRouter from "./fishing";\nimport bookingRouter from "./booking";`],
      [`router.use(fishingRouter);`, `router.use(fishingRouter);\nrouter.use(bookingRouter);`],
    ],
  },
  {
    path: `${ROOT}/artifacts/boat-fishing-lookup/src/App.tsx`,
    edits: [
      [`import SourceManager from '@/components/source-manager';`, `import SourceManager from '@/components/source-manager';\nimport AutoBooking from '@/components/auto-booking';`],
      [`const [showSourceManager, setShowSourceManager] = useState(false);`, `const [showSourceManager, setShowSourceManager] = useState(false);\n  const [showAutoBooking, setShowAutoBooking] = useState(false);`],
      [
        `data-testid="button-mobile-menu" aria-label="예약처 관리"><Menu size={18} /></button>`,
        `data-testid="button-mobile-menu" aria-label="예약처 관리"><Menu size={18} /></button>\n            <button type="button" onClick={() => setShowAutoBooking(true)} className="rounded-lg px-2 py-1.5 text-sm hover:bg-sidebar-accent md:hidden" data-testid="button-mobile-auto-booking">자동예약</button>`,
      ],
      [
        `data-testid="button-manage-sources"><Settings2 size={15} />예약처 관리</button>`,
        `data-testid="button-manage-sources"><Settings2 size={15} />예약처 관리</button>\n            <button type="button" onClick={() => setShowAutoBooking(true)} className="hidden items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-sidebar-accent sm:flex" data-testid="button-auto-booking">자동 예약</button>`,
      ],
      [`{showSourceManager ? (`, `{showAutoBooking ? (\n        <AutoBooking onBack={() => setShowAutoBooking(false)} />\n      ) : showSourceManager ? (`],
    ],
  },
];

// 새 파일 확인
for (const need of [`${ROOT}/artifacts/api-server/src/lib/booking.ts`, `${ROOT}/artifacts/api-server/src/routes/booking.ts`, `${ROOT}/artifacts/boat-fishing-lookup/src/components/auto-booking.tsx`]) {
  if (!fs.existsSync(need)) {
    console.log("중단: 파일이 없습니다 →", need);
    process.exit(1);
  }
}

const out = [];
for (const f of files) {
  let text = fs.readFileSync(f.path, "utf8");
  if (text.includes("auto-booking") || text.includes("bookingRouter")) {
    console.log("이미 적용됨:", f.path);
    continue;
  }
  for (const [from, to] of f.edits) {
    const n = text.split(from).length - 1;
    if (n !== 1) {
      console.log(`중단: 수정 대상이 ${n}곳입니다 (1곳이어야 함) → ${f.path}\n   ${from.slice(0, 70)}`);
      process.exit(1);
    }
    text = text.replace(from, () => to);
  }
  out.push([f.path, text]);
}
for (const [p, t] of out) {
  fs.copyFileSync(p, `/tmp/${p.split("/").pop()}.bak-booking`);
  fs.writeFileSync(p, t);
  console.log("적용:", p);
}
console.log("끝. 서버 빌드·재시작 후 화면을 새로고침하세요.");
