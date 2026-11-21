// 결과 내려받기 (CSV · 엑셀). 파일은 브라우저 안에서 만들어 바로 내려받는다 — 서버로 보내지 않는다.
export const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function safeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 60) || "결과";
}

function save(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** CSV (UTF-8 BOM — 엑셀에서 한글이 깨지지 않게) */
export function downloadCsv(baseName, columns, rows) {
  const lines = [columns.map((c) => csvCell(c.name)).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  const filename = `${safeFileName(baseName)}_${stamp()}.csv`;
  save(new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" }), filename);
  return filename;
}

/** 엑셀 xlsx (SheetJS, 필요할 때만 불러온다). 숫자는 숫자 칸으로 들어간다. */
export async function downloadXlsx(baseName, columns, rows, sheetName = "틀린 값") {
  const XLSX = await import(SHEETJS_URL);
  const aoa = [columns.map((c) => c.name), ...rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : v)))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = columns.map((c, i) => ({
    wch: Math.min(40, Math.max(String(c.name).length * 2, ...rows.slice(0, 200).map((r) => String(r[i] ?? "").length)) + 2),
  }));
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  const filename = `${safeFileName(baseName)}_${stamp()}.xlsx`;
  XLSX.writeFile(wb, filename);
  return filename;
}
