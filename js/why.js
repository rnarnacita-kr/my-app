// 결과 아래에 붙는 '왜' — ① 산출 근거, ② 원인 한 단계.
import * as db from "./db.js";
import * as guard from "./sqlguard.js";

const AI_ROW_LIMIT = 50;
let SCHEMA = null;

/** 불러온 schema.json (테이블 탭이 그레인 · 컬럼 뜻을 보여 줄 때 쓴다) */
export const getSchema = () => SCHEMA;

export async function loadSchema() {
  const res = await fetch("schema.json");
  if (!res.ok) throw new Error("schema.json 을 읽지 못했습니다");
  SCHEMA = await res.json();
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const fmt = (v) => (typeof v === "number" ? v.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : String(v ?? ""));

/** 결과 표 그리기 (main.js 와 같은 모양) */
export function tableEl({ columns, rows }, limit = 1000) {
  const wrap = el("div", "tablewrap");
  const t = el("table");
  const h = t.createTHead().insertRow();
  columns.forEach((c) => h.appendChild(el("th", "", c.name)));
  const b = t.createTBody();
  rows.slice(0, limit).forEach((r) => {
    const tr = b.insertRow();
    r.forEach((v) => {
      const td = tr.insertCell();
      if (typeof v === "number") td.className = "num";
      td.textContent = v === null ? "" : fmt(v);
    });
  });
  wrap.appendChild(t);
  wrap.appendChild(el("div", "meta", `${rows.length.toLocaleString("ko-KR")}행` + (rows.length > limit ? ` (앞 ${limit}행만 표시)` : "")));
  return wrap;
}

// ── 확인 요함 (결과 표 위에 붙는 빨간 상자) ───────────
/** items: 문자열 목록. 비어 있으면 null. */
export function alertEl(items, title = "확인 요함") {
  if (!items || !items.length) return null;
  const box = el("div", "alert-box");
  box.setAttribute("role", "alert");
  box.appendChild(el("strong", "alert-title", "⚠ " + title));
  const ul = el("ul");
  items.forEach((t) => ul.appendChild(el("li", "", t)));
  box.appendChild(ul);
  return box;
}

// ── ① 산출 근거 ──────────────────────────────────────
/** AI 가 말한 근거와 SQL 을 대조해 어긋난 점 목록을 돌려준다. */
export async function basisCheck(basis, sql) {
  basis = basis || {};
  const claimed = [...new Set((basis.tables || []).map((t) => String(t).toLowerCase()))].sort();
  let actual = [];
  try { actual = await guard.referencedTables(sql); } catch { /* 아래에서 확인 요함으로 표시 */ }
  const missing = actual.filter((t) => !claimed.includes(t)); // SQL 에는 있는데 근거에 없음
  const extra = claimed.filter((t) => !actual.includes(t));   // 근거에는 있는데 SQL 에 없음
  const metricDefs = new Map((SCHEMA?.metrics || []).map((m) => [m.name, m.definition]));
  const unknownMetrics = (basis.metrics || []).filter((m) => !metricDefs.has(m));
  const problems = [];
  if (!actual.length) problems.push("SQL에서 읽은 테이블을 찾지 못했습니다");
  if (missing.length) problems.push(`SQL에서 읽었지만 산출 근거에 없는 테이블: ${missing.join(", ")}`);
  if (extra.length) problems.push(`산출 근거에 있지만 SQL에서 읽지 않은 테이블: ${extra.join(", ")}`);
  if (unknownMetrics.length) problems.push(`데이터 사전에 없는 지표 이름: ${unknownMetrics.join(", ")}`);
  return { claimed, actual, metricDefs, problems };
}

export async function renderBasis(box, basis, sql) {
  box.innerHTML = "";
  box.hidden = false;
  basis = basis || {};
  const { claimed, actual, metricDefs, problems } = await basisCheck(basis, sql);

  const head = el("h3", "", "① 산출 근거 ");
  head.appendChild(problems.length ? el("span", "badge danger", "확인 요함") : el("span", "badge ok", "SQL과 일치"));
  box.appendChild(head);

  const dl = el("dl", "basis");
  const add = (k, items) => {
    dl.appendChild(el("dt", "", k));
    const dd = el("dd");
    if (!items.length) dd.appendChild(el("span", "muted", "없음"));
    items.forEach((it) => dd.appendChild(it instanceof Node ? it : el("div", "", it)));
    dl.appendChild(dd);
  };
  add("읽은 테이블", (actual.length ? actual : claimed).map((t) => el("code", "chip", t)));
  add("조건", (basis.filters || []).map(String));
  add("지표 정의", (basis.metrics || []).map((m) => {
    const d = el("div");
    d.appendChild(el("b", "", m));
    d.appendChild(document.createTextNode(" — " + (metricDefs.get(m) || "데이터 사전에 없는 이름")));
    return d;
  }));
  box.appendChild(dl);
  return problems; // 어긋난 점은 결과 표 위 «확인 요함» 상자에 보여 준다
}

// ── ② 원인 한 단계 ──────────────────────────────────
/** 가장 큰 덩어리(측정값 절댓값 최대)와 비중(값 ÷ 전체 합) — 브라우저 계산 */
export function biggestChunk(res, dimensionCols, measureCol) {
  const names = res.columns.map((c) => c.name);
  const mi = names.indexOf(measureCol);
  if (mi < 0) throw new Error(`결과에 측정값 컬럼(${measureCol})이 없습니다`);
  let di = dimensionCols.map((d) => names.indexOf(d)).filter((i) => i >= 0);
  if (!di.length) di = names.map((_, i) => i).filter((i) => i !== mi && typeof res.rows[0]?.[i] !== "number");
  const vals = res.rows.map((r) => Number(r[mi])).filter((v) => Number.isFinite(v));
  if (!vals.length) throw new Error("측정값이 숫자가 아닙니다");
  const total = vals.reduce((a, b) => a + b, 0);
  let best = null;
  res.rows.forEach((r) => {
    const v = Number(r[mi]);
    if (Number.isFinite(v) && (best === null || Math.abs(v) > Math.abs(Number(best[mi])))) best = r;
  });
  const value = Number(best[mi]);
  const mixed = vals.some((v) => v < 0) && vals.some((v) => v > 0);
  return {
    label: di.map((i) => `${names[i]} ${fmt(best[i])}`).join(" · "),
    measureCol,
    value,
    total,
    share: total !== 0 && !mixed ? value / total : null,
    groups: vals.length,
  };
}

export async function renderDrill(box, question, sql, mainRes, extraTables = []) {
  box.innerHTML = "";
  box.hidden = false;
  box.appendChild(el("h3", "", "② 원인 한 단계"));
  const status = el("p", "msg", "AI가 결과를 한 번 더 쪼개는 SQL을 쓰는 중…");
  box.appendChild(status);
  const fail = (m) => { status.textContent = m; status.className = "msg err"; };

  let out;
  try {
    // AI 에는 질문 · 원래 SQL · 원래 집계 결과 50행 이하만 보낸다.
    const res = await fetch("api/why", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        sql,
        columns: mainRes.columns.map((c) => c.name),
        rows: mainRes.rows.slice(0, AI_ROW_LIMIT),
        extra_tables: extraTables,
      }),
    });
    out = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
      if (out.drill_sql) box.appendChild(sqlBlock(out.drill_sql));
      return fail("원인 SQL을 받지 못했습니다 — " + (out.error || `HTTP ${res.status}`));
    }
  } catch (e) {
    return fail("원인 SQL 호출 실패 — " + e.message);
  }

  if (out.note) box.insertBefore(el("p", "note", out.note), status);
  box.appendChild(sqlBlock(out.drill_sql));

  const reason = await guard.check(out.drill_sql).catch((e) => "검사 중 오류: " + e.message);
  if (reason) return fail("원인 SQL을 실행하지 않았습니다 — " + reason);

  let res;
  try {
    res = await db.run(out.drill_sql);
  } catch (e) {
    return fail("원인 SQL 실행 오류 — " + e.message);
  }
  if (!res.rows.length) return fail("원인 SQL 결과가 비어 있습니다");

  try {
    const b = biggestChunk(res, out.dimension_cols || [], out.measure_col);
    const share = b.share === null ? "" : ` · 전체 ${fmt(b.total)}의 ${(b.share * 100).toFixed(1)}%`;
    status.className = "msg big";
    status.textContent = `가장 큰 덩어리: ${b.label} — ${b.measureCol} ${fmt(b.value)}${share} (${b.groups}개 묶음 중)`;
  } catch (e) {
    fail("가장 큰 덩어리를 계산하지 못했습니다 — " + e.message);
  }
  box.appendChild(tableEl(res));
}

function sqlBlock(sql) {
  const d = el("details", "sqlblock");
  d.appendChild(el("summary", "", "원인 SQL 보기"));
  d.appendChild(el("pre", "", sql));
  return d;
}
