import * as db from "./db.js";
import * as guard from "./sqlguard.js";
import * as why from "./why.js";
import * as saved from "./saved.js";
import * as upload from "./upload.js";
import * as tables from "./tables.js";

let lastQuestion = ""; // 지금 SQL 칸의 SQL 을 만든 질문 (저장할 때 같이 남김)

const $ = (id) => document.getElementById(id);

// ── 탭 ─────────────────────────────────────────────
document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== `tab-${btn.dataset.tab}`));
  });
});

function setMsg(text, kind = "") {
  $("msg").textContent = text;
  $("msg").className = "msg" + (kind ? " " + kind : "");
}

function clearBelow() {
  for (const id of ["alert", "result", "basis", "drill"]) {
    $(id).innerHTML = "";
    if (id === "basis" || id === "drill") $(id).hidden = true;
  }
}

// ── 실행: 검사 → 실행. 성공하면 결과를, 아니면 null 을 돌려준다 ──
async function runSql() {
  const sql = $("sql").value;
  clearBelow();
  const reason = await guard.check(sql).catch((e) => "검사 중 오류: " + e.message);
  if (reason) {
    setMsg("실행하지 않았습니다 — " + reason, "err");
    return null;
  }
  setMsg("실행 중…");
  const t0 = performance.now();
  try {
    const res = await db.run(sql);
    $("result").appendChild(why.tableEl(res));
    setMsg(`완료 (${Math.round(performance.now() - t0)} ms)`, "ok");
    return res;
  } catch (e) {
    setMsg("실행 오류 — " + e.message, "err");
    return null;
  }
}

// ── 묻기: 질문 → /api/sql → 실행 → ① 근거 → ② 원인 ──
async function ask() {
  const question = $("question").value.trim();
  if (!question) return setMsg("질문을 써 주세요", "err");
  $("btn-ask").disabled = true;
  clearBelow();
  setMsg("AI가 SQL을 쓰는 중…");
  try {
    // 질문과 올린 테이블의 설명(이름·컬럼·타입·행 수)만 보낸다. 기본 설명은 서버의 schema.json, 원본 행은 보내지 않는다.
    const res = await fetch("api/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, extra_tables: upload.tableDescriptions() }),
    });
    const out = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (out.sql) $("sql").value = out.sql;
    if (!res.ok) return setMsg(out.error || `HTTP ${res.status}`, "err");
    lastQuestion = question;
    if (!$("save-name").value.trim()) $("save-name").value = question.slice(0, 40);

    const sql = $("sql").value;
    const result = await runSql();
    if (!result) return;
    // ① 은 원인 단계와 상관없이 먼저 그린다. ② 가 실패해도 ① 과 원래 결과는 남는다.
    // ① 에서 어긋난 점은 결과 표 위에 빨간 «확인 요함» 상자로 띄운다.
    const problems = await why.renderBasis($("basis"), out.basis, sql).catch((e) => {
      $("basis").textContent = "산출 근거를 그리지 못했습니다 — " + e.message;
      return ["산출 근거를 확인하지 못했습니다: " + e.message];
    });
    const box = why.alertEl(problems);
    if (box) $("alert").appendChild(box);
    await why.renderDrill($("drill"), question, sql, result, upload.tableDescriptions()).catch((e) => {
      $("drill").textContent = "원인 한 단계 실패 — " + e.message;
    });
  } catch (e) {
    setMsg("AI 호출 실패 — " + e.message, "err");
  } finally {
    $("btn-ask").disabled = false;
  }
}

$("btn-ask").addEventListener("click", ask);
$("question").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) ask(); });
$("btn-run").addEventListener("click", runSql);
$("btn-save").addEventListener("click", async () => {
  const m = $("save-msg");
  $("btn-save").disabled = true;
  try {
    const err = await saved.saveQuestion({ name: $("save-name").value, question: lastQuestion, sql: $("sql").value });
    m.className = "msg " + (err ? "err" : "ok");
    m.textContent = err || "저장했습니다 — «준비된 질문» 탭에 추가됐고 JSON 파일로도 내려받았습니다";
  } finally {
    $("btn-save").disabled = false;
  }
});
$("sql").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runSql(); });

// ── 시작 ───────────────────────────────────────────
(async () => {
  const status = $("db-status");
  try {
    await guard.loadRules();
    await why.loadSchema();
    await db.init((m) => (status.textContent = m));
    const names = await db.tableNames();
    status.textContent = `데이터 준비 완료 · 테이블 ${names.length}개`;
    status.className = "status ok";
    $("btn-ask").disabled = false;
    $("btn-run").disabled = false;
    $("btn-save").disabled = false;
    await saved.init($("saved-list"));
    await tables.render($("table-list"));
    // 올린 뒤에는 테이블 탭만 새로 그린다. 준비된 질문은 자동으로 다시 계산하지 않는다.
    upload.init({ drop: $("dropzone"), input: $("file-input"), list: $("upload-list"),
                  changed: () => tables.render($("table-list")) });
    // ?autorun=presets : 준비된 질문 탭을 열고 모두 다시 계산 (검산·시연용)
    if (new URLSearchParams(location.search).get("autorun") === "presets") {
      document.querySelector('.tabs button[data-tab="saved"]').click();
      await Promise.all([...document.querySelectorAll("#saved-list button.recalc")].map((b) => {
        b.click();
        return new Promise((ok) => { const t = setInterval(() => { if (!b.disabled) { clearInterval(t); ok(); } }, 100); });
      }));
      document.body.dataset.autorun = "done";
    }
  } catch (e) {
    status.textContent = "데이터 준비 실패 — " + e.message;
    status.className = "status err";
  }
})();
