// 테이블 탭: 올라와 있는 테이블을 실제 표로 보여 준다.
// 위쪽 단추로 테이블을 고르면 → 한 행의 뜻 · 행 수 · 키 · 출처 → 처음 10행 샘플 표(머리줄에 타입 · 뜻) → 컬럼 설명.
// 읽기만 하는 앱 내부 조회라 사용자/AI SQL 검사 대상이 아니다.
import * as db from "./db.js";
import { uploaded } from "./upload.js";
import { getSchema } from "./why.js";

const PREVIEW_ROWS = 10;
let current = null;          // 고른 테이블 이름
let lastBox = null;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const n = (v) => Number(v).toLocaleString("ko-KR");

/** schema.json 의 설명. 올린 파일로 바뀐 테이블도 컬럼 이름이 같으면 뜻을 그대로 쓴다. */
function describe(name, columns) {
  const t = (getSchema()?.tables || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!t) return { grain: null, key: null, meaning: {} };
  const meaning = {};
  for (const c of t.columns || []) meaning[c.name.toLowerCase()] = c.meaning;
  const same = columns.every((c) => meaning[c.name.toLowerCase()] !== undefined);
  return { grain: t.grain, key: t.key, meaning: same ? meaning : {} };
}

function isNumType(type) {
  return /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i.test(type);
}

export async function render(box) {
  lastBox = box || lastBox;
  box = lastBox;
  const tables = await db.describeAll();
  if (!tables.length) { box.textContent = "올라와 있는 테이블이 없습니다."; return; }
  if (!current || !tables.some((t) => t.name === current)) current = tables[0].name;

  box.innerHTML = "";
  // 1) 테이블 고르기
  const bar = el("div", "tpick");
  bar.setAttribute("role", "tablist");
  for (const t of tables) {
    const up = uploaded.get(t.name.toLowerCase());
    const b = el("button", "tchip" + (t.name === current ? " active" : ""));
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(t.name === current));
    b.dataset.table = t.name;
    b.appendChild(el("b", "", t.name));
    b.appendChild(el("span", "cnt", `${n(t.row_count)}행`));
    if (up) b.appendChild(el("span", "up", "올린 파일"));
    b.addEventListener("click", () => { current = t.name; render(); });
    bar.appendChild(b);
  }
  box.appendChild(bar);

  // 2) 고른 테이블
  const t = tables.find((x) => x.name === current);
  const up = uploaded.get(t.name.toLowerCase());
  const info = describe(t.name, t.columns);
  const card = el("article", "qcard tview");
  card.dataset.table = t.name;

  const head = el("div", "qhead");
  const h = el("h3", "", t.name + " ");
  h.appendChild(up ? el("span", "badge warn", `올린 파일 · ${up.file}`) : el("span", "badge ok", "기본 data/"));
  head.appendChild(h);
  head.appendChild(el("span", "rows", `${n(t.row_count)}행 · 컬럼 ${t.columns.length}개`));
  card.appendChild(head);

  const meta = el("dl", "tmeta");
  const add = (k, v) => { if (!v) return; meta.appendChild(el("dt", "", k)); meta.appendChild(el("dd", "", v)); };
  add("한 행 =", info.grain || (up ? "올린 파일 — 데이터 사전에 설명 없음" : null));
  add("키", info.key ? info.key.join(" + ") : null);
  card.appendChild(meta);

  // 3) 데이터 표 (처음 50행)
  const res = await db.exec(`SELECT * FROM ${db.ident(t.name)} LIMIT ${PREVIEW_ROWS}`);
  const wrap = el("div", "grid-wrap");
  const table = el("table", "grid");
  const thr = table.createTHead().insertRow();
  const corner = el("th", "rn", "#");
  thr.appendChild(corner);
  res.columns.forEach((c, i) => {
    const type = t.columns[i]?.type || c.type;
    const th = el("th", isNumType(type) ? "num" : "");
    th.appendChild(el("span", "cname", c.name));
    th.appendChild(el("span", "ctype", type));
    const m = info.meaning[c.name.toLowerCase()];
    if (m) th.title = `${c.name} — ${m}`;
    thr.appendChild(th);
  });
  const tb = table.createTBody();
  res.rows.forEach((r, ri) => {
    const tr = tb.insertRow();
    tr.appendChild(el("td", "rn", String(ri + 1)));
    r.forEach((v, i) => {
      const type = t.columns[i]?.type || "";
      const td = tr.insertCell();
      if (v === null || v === undefined) {
        td.className = "null";
        td.textContent = "NULL";
      } else if (typeof v === "number") {
        td.className = "num";
        td.textContent = v.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
      } else {
        td.textContent = String(v);
        if (isNumType(type)) td.className = "num";
      }
    });
  });
  wrap.appendChild(table);
  card.appendChild(wrap);
  card.appendChild(el("p", "meta",
    `처음 ${n(Math.min(PREVIEW_ROWS, t.row_count))}행 / 전체 ${n(t.row_count)}행 · 머리줄에 마우스를 올리면 컬럼 뜻 · 흐린 NULL 은 빈 값`));

  // 4) 컬럼 설명
  const det = el("details", "colinfo");
  det.appendChild(el("summary", "", "컬럼 설명 보기"));
  const ct = el("table", "colt");
  ct.innerHTML = "<thead><tr><th>컬럼</th><th>타입</th><th>뜻 (데이터 사전)</th></tr></thead>";
  const cb = ct.createTBody();
  t.columns.forEach((c) => {
    const tr = cb.insertRow();
    tr.appendChild(el("td", "mono", c.name));
    tr.appendChild(el("td", "ctype", c.type));
    tr.appendChild(el("td", "", info.meaning[c.name.toLowerCase()] || "—"));
  });
  det.appendChild(ct);
  card.appendChild(det);
  box.appendChild(card);
}
