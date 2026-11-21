// DuckDB-WASM: 브라우저 안에서만 데이터를 읽는다.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

export const BASE_TABLES = ["products", "set_components", "mall_orders", "shipments", "mall_settlements"];

let db = null;
let conn = null;

export async function init(onProgress = () => {}) {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();

  for (const t of BASE_TABLES) {
    onProgress(`${t} 불러오는 중…`);
    const res = await fetch(`data/${t}.csv`);
    if (!res.ok) throw new Error(`data/${t}.csv 를 읽지 못했습니다 (HTTP ${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const fname = `${t}.csv`;
    await db.registerFileBuffer(fname, buf);
    // 앱 내부 적재용 문장 — 사용자/AI SQL 이 아니므로 검사 대상이 아니다.
    await conn.query(`CREATE OR REPLACE TABLE "${t}" AS SELECT * FROM read_csv_auto('${fname}', header = true)`);
  }
}

/** 식별자 따옴표 처리 */
export const ident = (s) => `"${String(s).replaceAll('"', '""')}"`;

/** 앱 내부용 파일 등록/해제 (올린 파일은 브라우저 메모리에만 있다) */
export async function registerFile(name, bytes) {
  await db.registerFileBuffer(name, bytes);
}
export async function dropFile(name) {
  try { await db.dropFile(name); } catch { /* 이미 없으면 무시 */ }
}

/** 앱 내부 문장 실행 (적재·DESCRIBE 등). 사용자/AI SQL 은 여기로 보내지 않는다. */
export async function exec(sql) {
  return run(sql);
}

/** 테이블마다 컬럼(이름·타입)과 행 수 */
export async function describeAll() {
  const r = await run(
    "SELECT table_name, column_name, data_type FROM information_schema.columns " +
      "WHERE table_schema = 'main' ORDER BY table_name, ordinal_position"
  );
  const map = new Map();
  for (const [t, c, ty] of r.rows) {
    if (!map.has(t)) map.set(t, { name: t, columns: [] });
    map.get(t).columns.push({ name: c, type: ty });
  }
  for (const t of map.values()) t.row_count = await rowCount(t.name);
  return [...map.values()];
}

/** 지금 올라와 있는 테이블 이름 목록 */
export async function tableNames() {
  const r = await conn.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
  );
  return r.toArray().map((row) => row.table_name);
}

/** 테이블별 행 수 */
export async function rowCount(table) {
  const r = await conn.query(`SELECT count(*)::INTEGER AS n FROM "${table.replaceAll('"', '""')}"`);
  return r.toArray()[0].n;
}

/** json_serialize_sql 결과(문자열). 검사기가 쓴다. */
export async function serializeSql(sql) {
  // WASM 판은 ? 의 타입을 모른 채 바인딩하므로 VARCHAR 로 못박는다.
  const stmt = await conn.prepare("SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS j");
  try {
    const r = await stmt.query(sql);
    return r.toArray()[0].j;
  } finally {
    await stmt.close();
  }
}

/** 검사를 통과한 SQL 만 넘겨야 한다. {columns, rows} 로 돌려준다. */
export async function run(sql) {
  const table = await conn.query(sql);
  const fields = table.schema.fields;
  const columns = fields.map((f) => ({ name: f.name, type: String(f.type), scale: f.type.scale ?? 0 }));
  const rows = table.toArray().map((r) => {
    const o = r.toJSON();
    return columns.map((c) => toPlain(o[c.name], c.type, c.scale));
  });
  return { columns, rows };
}

/** Arrow DECIMAL 값은 소수점을 뺀 정수(예: 20.0 → 200, scale 1)로 오므로 scale 만큼 나눈다. */
function decimalToNumber(v, scale) {
  let n;
  if (typeof v === "bigint") n = v;
  else if (v instanceof Uint32Array || v instanceof Int32Array) {
    const w = Uint32Array.from(v);
    n = 0n;
    for (let i = w.length - 1; i >= 0; i--) n = (n << 32n) | BigInt(w[i]);
    if (w[w.length - 1] & 0x80000000) n -= 1n << BigInt(32 * w.length); // 음수(2의 보수)
  } else if (typeof v === "number") {
    return v; // 이미 소수로 풀린 값
  } else {
    n = BigInt(String(v));
  }
  const d = 10n ** BigInt(scale);
  return Number(n / d) + Number(n % d) / Number(d);
}

function toPlain(v, type, scale = 0) {
  if (v === null || v === undefined) return null;
  if (type.startsWith("Decimal")) return decimalToNumber(v, scale);
  if (typeof v === "bigint") {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  if (type.startsWith("Date")) return new Date(Number(v)).toISOString().slice(0, 10);
  if (type.startsWith("Timestamp")) return new Date(Number(v)).toISOString().replace("T", " ").slice(0, 19);
  if (v instanceof Uint32Array || v instanceof Int32Array) return Number(v[0]);
  return v;
}
