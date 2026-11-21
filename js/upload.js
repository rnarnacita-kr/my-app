// 내 파일: CSV(UTF-8, BOM 무시) · xlsx(첫 시트, 첫 행 = 컬럼 이름)를 브라우저 안 DuckDB 테이블로 올린다.
// 파일 내용은 브라우저 밖으로 나가지 않는다. 새로고침하면 사라진다.
import * as db from "./db.js";
import { tableEl, alertEl } from "./why.js";

const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const PREVIEW_ROWS = 20;

/** 이번 세션에 올린 테이블: 이름(소문자) → {name, file, columns, row_count} */
export const uploaded = new Map();

let seq = 0;
let onChange = () => {};

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const n = (v) => Number(v).toLocaleString("ko-KR");

/** AI 에 보낼 올린 테이블 설명 (이름 · 컬럼 이름 · 타입 · 행 수만, 행 내용 없음) */
export function tableDescriptions() {
  return [...uploaded.values()].map((t) => ({ name: t.name, row_count: t.row_count, columns: t.columns }));
}

export function init({ drop, input, list, changed }) {
  onChange = changed || onChange;
  input.addEventListener("change", () => { handleFiles([...input.files], list); input.value = ""; });
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); })
  );
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => { e.preventDefault(); handleFiles([...e.dataTransfer.files], list); });
}

async function handleFiles(files, list) {
  document.body.dataset.upload = "busy";
  for (const f of files) {
    const card = el("article", "qcard upcard");
    list.prepend(card);
    try {
      await loadOne(f, card);
    } catch (e) {
      card.appendChild(el("p", "msg err", `${f.name} — 올리지 못했습니다: ${e.message}`));
    }
  }
  document.body.dataset.upload = "done";
  onChange();
}

async function loadOne(file, card) {
  const m = /^(.*)\.(csv|xlsx)$/i.exec(file.name);
  if (!m) throw new Error("CSV(.csv) 또는 엑셀(.xlsx) 파일만 올릴 수 있습니다");
  const table = m[1].trim();
  if (!table) throw new Error("파일 이름이 비어 있습니다");
  const kind = m[2].toLowerCase();
  card.appendChild(el("h3", "", `${file.name} → 테이블 ${table}`));
  const status = el("p", "msg", "읽는 중…");
  card.appendChild(status);

  // 1) 파일 → CSV 바이트 + 파일에서 읽은 행 수
  let bytes, fileRows;
  if (kind === "csv") {
    bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3); // BOM 무시
    fileRows = countCsvRecords(new TextDecoder("utf-8").decode(bytes)) - 1; // 첫 행은 컬럼 이름
  } else {
    const XLSX = await import(SHEETJS_URL);
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    if (!aoa.length) throw new Error("첫 시트가 비어 있습니다");
    fileRows = aoa.length - 1;
    bytes = new TextEncoder().encode(aoaToCsv(aoa));
  }
  if (fileRows < 0) throw new Error("컬럼 이름 행이 없습니다");

  // 2) DuckDB 에 등록 → 컬럼 이름 정리(공백 → 밑줄) → 같은 이름이면 바꿔 넣기
  const fname = `upload_${++seq}.csv`;
  await db.registerFile(fname, bytes);
  const src = `read_csv('${fname}', header = true, auto_detect = true)`;
  try {
    const desc = await db.exec(`DESCRIBE SELECT * FROM ${src}`);
    const names = desc.rows.map((r) => String(r[0]));
    const renamed = [];
    const used = new Set();
    const cols = names.map((c) => {
      let to = c.trim().replace(/\s+/g, "_") || "column";
      if (to !== c) renamed.push([c, to]);
      let k = to, i = 1;
      while (used.has(k.toLowerCase())) k = `${to}_${i++}`;
      used.add(k.toLowerCase());
      return `${db.ident(c)} AS ${db.ident(k)}`;
    });
    const existed = (await db.tableNames()).some((t) => t.toLowerCase() === table.toLowerCase());
    const before = existed ? await db.rowCount(table) : null;
    await db.exec(`CREATE OR REPLACE TABLE ${db.ident(table)} AS SELECT ${cols.join(", ")} FROM ${src}`);

    // 3) 행 수 대조 + 미리보기
    const tableRows = await db.rowCount(table);
    const ok = tableRows === fileRows;
    status.className = "msg " + (ok ? "ok" : "err");
    status.textContent = existed
      ? `같은 이름의 테이블을 새 파일로 바꿨습니다 (전: ${n(before)}행 → 지금: ${n(tableRows)}행)`
      : "새 테이블로 올렸습니다";
    if (!ok) {
      card.appendChild(alertEl([
        `파일에서 읽은 행 수(${n(fileRows)})와 테이블에 올라간 행 수(${n(tableRows)})가 다릅니다. ` +
          "파일을 확인하기 전까지 이 테이블로 낸 결과는 믿지 마세요.",
      ]));
    }
    const cmp = el("table", "cmp");
    cmp.innerHTML = "<thead><tr><th>파일에서 읽은 행 수</th><th>테이블에 올라간 행 수</th><th></th></tr></thead>";
    const tr = cmp.createTBody().insertRow();
    tr.insertCell().textContent = n(fileRows);
    tr.insertCell().textContent = n(tableRows);
    const mark = tr.insertCell();
    mark.textContent = ok ? "✓" : "✕";
    mark.className = ok ? "mark ok" : "mark err";
    card.appendChild(cmp);
    if (renamed.length) {
      card.appendChild(el("p", "msg warn",
        "컬럼 이름의 공백을 밑줄로 바꿨습니다: " + renamed.map(([a, b]) => `«${a}» → ${b}`).join(", ")));
    }
    const prev = await db.exec(`SELECT * FROM ${db.ident(table)} LIMIT ${PREVIEW_ROWS}`);
    card.appendChild(el("p", "muted small", `처음 ${Math.min(PREVIEW_ROWS, tableRows)}행 미리보기`));
    card.appendChild(tableEl(prev));

    const info = (await db.exec(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'main' ` +
        `AND lower(table_name) = lower('${table.replaceAll("'", "''")}') ORDER BY ordinal_position`
    )).rows.map(([name, type]) => ({ name, type }));
    uploaded.set(table.toLowerCase(), { name: table, file: file.name, columns: info, row_count: tableRows });
    card.dataset.table = table;
    card.dataset.ok = String(ok);
  } finally {
    await db.dropFile(fname);
  }
}

/** 따옴표를 고려해 CSV 레코드 수를 센다(빈 끝줄 제외). */
export function countCsvRecords(text) {
  let count = 0, inQ = false, hasContent = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') i++;
        else inQ = false;
      }
    } else if (c === '"') {
      inQ = true; hasContent = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (hasContent) count++;
      hasContent = false;
    } else {
      hasContent = true;
    }
  }
  if (hasContent) count++;
  return count;
}

function cellToCsv(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    const iso = new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
  }
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function aoaToCsv(aoa) {
  const width = Math.max(...aoa.map((r) => r.length));
  const header = Array.from({ length: width }, (_, i) => {
    const h = aoa[0][i];
    return h === null || h === undefined || String(h).trim() === "" ? `column${i + 1}` : String(h);
  });
  const lines = [header.map(cellToCsv).join(",")];
  for (const r of aoa.slice(1)) lines.push(Array.from({ length: width }, (_, i) => cellToCsv(r[i])).join(","));
  return lines.join("\n") + "\n";
}
