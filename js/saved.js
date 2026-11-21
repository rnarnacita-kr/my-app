// 준비된 질문: presets/questions.json(기본) + 이 브라우저에 저장한 질문(localStorage).
// 다시 계산할 때도, 저장할 때도 같은 읽기 전용 검사를 거친다.
import * as db from "./db.js";
import * as guard from "./sqlguard.js";
import { tableEl, alertEl } from "./why.js";
import { downloadCsv, downloadXlsx } from "./export.js";

const STORE_KEY = "my-app.saved-questions.v1";
let presets = [];
let listBox = null;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ── 저장소 (localStorage 는 막혀 있을 수 있으니 항상 try/catch) ──
export function loadMine() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function storeMine(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** 묻기 탭에서 부른다. 검사를 통과해야 저장한다. 성공하면 null, 아니면 사유. */
export async function saveQuestion({ name, question, sql }) {
  name = (name || "").trim();
  if (!name) return "이름을 붙여 주세요";
  const reason = await guard.check(sql).catch((e) => "검사 중 오류: " + e.message);
  if (reason) return "저장하지 않았습니다 — " + reason;
  const item = {
    id: "mine-" + Date.now().toString(36),
    name,
    question: (question || "").trim(),
    sql: sql.trim(),
    tables: await guard.referencedTables(sql),
    saved_at: new Date().toISOString(),
  };
  const mine = loadMine();
  mine.push(item);
  const ok = storeMine(mine);
  downloadJson([item], `질문_${safeName(name)}.json`);
  render();
  return ok ? null : "이 브라우저에는 저장하지 못했습니다(저장소가 막혀 있음). 내려받은 JSON 파일은 남아 있습니다.";
}

function safeName(s) {
  return s.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "질문";
}

function downloadJson(questions, filename) {
  const blob = new Blob([JSON.stringify({ version: 1, questions }, null, 2)], { type: "application/json" });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── 화면 ──────────────────────────────────────────
export async function init(box) {
  listBox = box;
  const res = await fetch("presets/questions.json");
  if (!res.ok) throw new Error("presets/questions.json 을 읽지 못했습니다");
  presets = (await res.json()).questions || [];
  render();
}

function render() {
  if (!listBox) return;
  listBox.innerHTML = "";
  const bar = el("div", "row savedbar");
  const all = el("button", "", "모두 다시 계산");
  all.addEventListener("click", () => listBox.querySelectorAll("button.recalc").forEach((b) => b.click()));
  const dl = el("button", "", "저장한 질문 JSON 내려받기");
  dl.addEventListener("click", () => downloadJson([...presets, ...loadMine()], "questions.json"));
  bar.append(all, dl);
  listBox.appendChild(bar);

  presets.forEach((q) => listBox.appendChild(card(q, false)));
  const mine = loadMine();
  if (mine.length) {
    listBox.appendChild(el("h3", "group", "내가 저장한 질문"));
    mine.forEach((q) => listBox.appendChild(card(q, true)));
  }
}

function card(q, removable) {
  const c = el("article", "qcard");
  c.dataset.id = q.id;
  const head = el("div", "qhead");
  head.appendChild(el("h3", "", q.name));
  const btns = el("div", "row");
  const run = el("button", "primary recalc", "다시 계산");
  btns.appendChild(run);
  if (removable) {
    const del = el("button", "", "삭제");
    del.addEventListener("click", () => {
      if (!confirm(`«${q.name}» 을(를) 이 브라우저에서 지울까요?`)) return;
      storeMine(loadMine().filter((x) => x.id !== q.id));
      render();
    });
    btns.appendChild(del);
  }
  head.appendChild(btns);
  c.appendChild(head);
  if (q.question) c.appendChild(el("p", "qtext", q.question));
  // 메모: 목록(배열)이면 한 줄씩, 문자열이면 줄바꿈(\n)마다 나눠 보여 준다.
  const noteLines = (Array.isArray(q.note) ? q.note : String(q.note || "").split("\n"))
    .map((s) => String(s).trim()).filter(Boolean);
  if (noteLines.length) {
    const ul = el("ul", "qnote");
    noteLines.forEach((line) => ul.appendChild(el("li", "", line)));
    c.appendChild(ul);
  }
  const d = el("details", "sqlblock");
  d.appendChild(el("summary", "", "SQL 보기"));
  d.appendChild(el("pre", "", q.sql));
  c.appendChild(d);
  const meta = el("p", "msg");
  const out = el("div", "qresult");
  c.append(meta, out);
  run.addEventListener("click", () => recalc(q, meta, out, run));
  return c;
}

/**
 * 질문에 정해 둔 «확인 조건»(alert)을 결과에 대 본다.
 * alert = {
 *   where:     { col: "차액 거래 수", op: ">", value: 0 }   // 없으면 모든 행
 *   min_rows:  1                                            // 걸린 행이 이만큼 이상이면 띄운다
 *   sum_col:   "차이"                                       // {sum} = 걸린 행의 이 컬럼 합
 *   list_cols: ["쇼핑몰", "월"]                             // {list} = 걸린 행의 이 컬럼들
 *   message:   "… {rows}건 … {sum}원 … {list}"
 * }
 * 숫자는 모두 결과 표에서 브라우저가 계산한다.
 */
const OPS = {
  ">": (a, b) => Number(a) > Number(b),
  ">=": (a, b) => Number(a) >= Number(b),
  "<": (a, b) => Number(a) < Number(b),
  "<=": (a, b) => Number(a) <= Number(b),
  "=": (a, b) => String(a) === String(b),
  "!=": (a, b) => String(a) !== String(b),
  "~": (a, b) => new RegExp(String(b)).test(String(a ?? "")),   // 글자 패턴(정규식)에 맞으면
};
const LIST_MAX = 12;

/** 확인 조건에 걸린 행과 상자에 쓸 문장. { items: [...], rows: [...] } */
function alertMatch(alert, res) {
  const none = { items: [], rows: [] };
  if (!alert) return none;
  const idx = (name) => res.columns.findIndex((c) => c.name === name);
  let rows = res.rows;
  if (alert.where) {
    const i = idx(alert.where.col);
    const op = OPS[alert.where.op];
    if (i < 0 || !op) return { items: [`확인 조건의 컬럼(${alert.where.col})이나 비교(${alert.where.op})를 결과에서 찾지 못했습니다`], rows: [] };
    rows = rows.filter((r) => op(r[i], alert.where.value));
  }
  if (rows.length < (alert.min_rows ?? 1)) return none;
  let sum = "";
  const si = alert.sum_col ? idx(alert.sum_col) : -1;
  if (si >= 0) sum = rows.reduce((a, r) => a + (Number(r[si]) || 0), 0).toLocaleString("ko-KR");
  let list = "";
  const li = (alert.list_cols || []).map(idx).filter((i) => i >= 0);
  if (li.length) {
    const items = rows.map((r) => li.map((i) => r[i]).join(" "));
    list = items.slice(0, LIST_MAX).join(", ") + (items.length > LIST_MAX ? ` 외 ${items.length - LIST_MAX}개` : "");
  }
  const items = [String(alert.message || "확인할 결과가 있습니다")
    .replaceAll("{rows}", rows.length.toLocaleString("ko-KR"))
    .replaceAll("{sum}", sum)
    .replaceAll("{list}", list)];
  return { items, rows };
}

/** alert.download_where = { col, op, value } 가 있으면 그 조건에 맞는 행, 없으면 null */
function downloadRows(alert, res) {
  const w = alert && alert.download_where;
  if (!w) return null;
  const i = res.columns.findIndex((c) => c.name === w.col);
  const op = OPS[w.op];
  if (i < 0 || !op) return null;
  return res.rows.filter((r) => op(r[i], w.value));
}

/** «확인 요함» 상자 안에 틀린 값 내려받기 단추 (CSV · 엑셀) */
function addDownloadButtons(box, q, columns, rows) {
  const bar = el("div", "row alert-actions");
  const name = `${q.name}_틀린값`;
  const msg = el("span", "msg");
  const csv = el("button", "", `틀린 값 CSV 내려받기 (${rows.length.toLocaleString("ko-KR")}행)`);
  csv.className = "dl-csv";
  csv.addEventListener("click", () => {
    const f = downloadCsv(name, columns, rows);
    msg.textContent = `내려받음: ${f}`;
  });
  const xlsx = el("button", "", "틀린 값 엑셀 내려받기");
  xlsx.className = "dl-xlsx";
  xlsx.addEventListener("click", async () => {
    xlsx.disabled = true;
    try {
      const f = await downloadXlsx(name, columns, rows);
      msg.textContent = `내려받음: ${f}`;
    } catch (e) {
      msg.textContent = "엑셀을 만들지 못했습니다 — " + e.message;
    } finally {
      xlsx.disabled = false;
    }
  });
  bar.append(csv, xlsx, msg);
  box.appendChild(bar);
}

async function recalc(q, meta, out, btn) {
  btn.disabled = true;
  out.innerHTML = "";
  meta.className = "msg";
  meta.textContent = "계산 중…";
  try {
    const reason = await guard.check(q.sql).catch((e) => "검사 중 오류: " + e.message);
    if (reason) {
      meta.className = "msg err";
      meta.textContent = "실행하지 않았습니다 — " + reason;
      return;
    }
    const res = await db.run(q.sql);
    const tables = await guard.referencedTables(q.sql);
    const at = new Date().toLocaleString("ko-KR", { hour12: false });
    meta.className = "msg ok";
    meta.textContent = `계산한 시각 ${at} · ${res.rows.length.toLocaleString("ko-KR")}행 · 읽은 테이블 ${tables.join(", ")}`;
    const m = alertMatch(q.alert, res);
    const box = alertEl(m.items);
    if (box) {
      // 내려받는 행은 따로 넓힐 수 있다(alert.download_where). 없으면 상자에 걸린 행 그대로.
      const dlRows = downloadRows(q.alert, res) ?? m.rows;
      if (dlRows.length) addDownloadButtons(box, q, res.columns, dlRows);
      out.appendChild(box); // 표보다 먼저
    }
    out.appendChild(tableEl(res, 5000)); // 거래 목록형 질문도 다 보이게
  } catch (e) {
    meta.className = "msg err";
    meta.textContent = "실행 오류 — " + e.message;
  } finally {
    btn.disabled = false;
  }
}
