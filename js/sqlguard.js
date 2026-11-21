// 읽기 전용 SQL 검사 (브라우저 판). api/_sqlguard.py 와 같은 규칙·같은 순서.
// AI 가 쓴 SQL 이든 직접 쓴 SQL 이든 실행 전에 반드시 check() 를 거친다.
import * as db from "./db.js";

let RULES = null;
let KW = [];
let FN = [];
const FROM_STR = /(?<![A-Za-z0-9_])(FROM|JOIN)\s+__STR__/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function loadRules() {
  const res = await fetch("sqlguard_rules.json");
  if (!res.ok) throw new Error("sqlguard_rules.json 을 읽지 못했습니다");
  RULES = await res.json();
  KW = RULES.forbidden_keywords.map((k) => [k, new RegExp(`(?<![A-Za-z0-9_])${esc(k)}(?![A-Za-z0-9_])`, "i")]);
  FN = RULES.forbidden_functions.map((f) => [f, new RegExp(`(?<![A-Za-z0-9_])${esc(f)}\\s*\\(`, "i")]);
}

/** 주석은 공백, '문자열' 은 __STR__, "식별자" 는 __ID__ 로 바꾼다. */
export function mask(sql) {
  const out = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (sql.startsWith("--", i)) {
      const j = sql.indexOf("\n", i);
      i = j < 0 ? n : j;
      out.push(" ");
    } else if (sql.startsWith("/*", i)) {
      const j = sql.indexOf("*/", i + 2);
      if (j < 0) throw new Error("닫히지 않은 주석이 있습니다");
      i = j + 2;
      out.push(" ");
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        j = sql.indexOf(c, j);
        if (j < 0) throw new Error("닫히지 않은 따옴표가 있습니다");
        if (j + 1 < n && sql[j + 1] === c) { j += 2; continue; }
        break;
      }
      out.push(c === "'" ? " __STR__ " : " __ID__ ");
      i = j + 1;
    } else {
      out.push(c);
      i += 1;
    }
  }
  return out.join("");
}

/** 1단계: 글자 검사. 통과하면 null, 막히면 사유. */
export function checkText(sql) {
  if (typeof sql !== "string" || !sql.trim()) return "SQL이 비어 있습니다";
  if (sql.length > RULES.max_length) return "SQL이 너무 깁니다";
  let m;
  try { m = mask(sql); } catch (e) { return e.message; }
  m = m.trim();
  while (m.endsWith(";")) m = m.slice(0, -1).trimEnd();
  if (m.includes(";")) return "한 번에 한 문장만 실행할 수 있습니다";
  const first = /^[\s(]*([A-Za-z]+)/.exec(m);
  if (!first || !RULES.allowed_start.includes(first[1].toUpperCase()))
    return "읽기(SELECT · WITH)로 시작하는 SQL만 실행할 수 있습니다";
  for (const [k, rx] of KW) if (rx.test(m)) return `읽기 전용이 아닌 키워드(${k})가 있습니다`;
  for (const [f, rx] of FN) if (rx.test(m)) return `허용하지 않는 함수(${f})가 있습니다`;
  if (FROM_STR.test(m)) return "파일 경로를 직접 읽을 수 없습니다. 올라와 있는 테이블만 쓸 수 있습니다";
  return null;
}

function walk(node, tables, funcs, ctes) {
  if (Array.isArray(node)) { for (const v of node) walk(v, tables, funcs, ctes); return; }
  if (!node || typeof node !== "object") return;
  if (node.type === "BASE_TABLE") tables.push([node.catalog_name || "", node.schema_name || "", node.table_name || ""]);
  else if (node.type === "TABLE_FUNCTION") funcs.push(node.function?.function_name || "");
  if (node.cte_map && Array.isArray(node.cte_map.map)) for (const e of node.cte_map.map) ctes.add(String(e.key).toLowerCase());
  for (const v of Object.values(node)) walk(v, tables, funcs, ctes);
}

/** 2단계: DuckDB 구문 트리 검사. */
export async function checkAst(sql) {
  const tree = JSON.parse(await db.serializeSql(sql));
  if (tree.error) return "SELECT 문이 아니거나 구문 오류입니다: " + (tree.error_message || "");
  if ((tree.statements || []).length !== 1) return "한 번에 한 문장만 실행할 수 있습니다";
  const tables = [], funcs = [], ctes = new Set();
  walk(tree, tables, funcs, ctes);
  const allowed = new Set((await db.tableNames()).map((t) => t.toLowerCase()));
  for (const c of ctes) allowed.add(c);
  for (const [cat, sch, name] of tables) {
    if (cat || sch || !allowed.has(name.toLowerCase()))
      return `올라와 있지 않은 테이블(${[cat, sch, name].filter(Boolean).join(".")})을 읽으려 합니다`;
  }
  const okFn = new Set(RULES.allowed_table_functions.map((f) => f.toLowerCase()));
  for (const fn of funcs) if (!okFn.has(fn.toLowerCase())) return `허용하지 않는 테이블 함수(${fn})가 있습니다`;
  return null;
}

/** SQL 이 실제로 읽는 테이블 이름(소문자, CTE 제외, 중복 제거). */
export async function referencedTables(sql) {
  const tree = JSON.parse(await db.serializeSql(sql));
  if (tree.error) return [];
  const tables = [], funcs = [], ctes = new Set();
  walk(tree, tables, funcs, ctes);
  const names = tables.map(([, , n]) => n.toLowerCase()).filter((n) => !ctes.has(n));
  return [...new Set(names)].sort();
}

/** 실행 전 검사. 통과하면 null, 막히면 사유. */
export async function check(sql) {
  return checkText(sql) || (await checkAst(sql));
}
