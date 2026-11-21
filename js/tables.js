// 테이블 탭: 지금 올라와 있는 테이블의 이름 · 출처 · 행 수 · 컬럼(이름 · 타입).
import * as db from "./db.js";
import { uploaded } from "./upload.js";

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export async function render(box) {
  const tables = await db.describeAll();
  box.innerHTML = "";
  box.appendChild(el("p", "muted small", `테이블 ${tables.length}개 · 올린 파일로 바뀌거나 더해진 테이블은 «올린 파일»로 표시`));
  for (const t of tables) {
    const up = uploaded.get(t.name.toLowerCase());
    const card = el("article", "qcard tcard");
    card.dataset.table = t.name;
    const head = el("div", "qhead");
    const h = el("h3", "", t.name + " ");
    h.appendChild(up ? el("span", "badge warn", `올린 파일 · ${up.file}`) : el("span", "badge ok", "기본 data/"));
    head.appendChild(h);
    head.appendChild(el("span", "rows", `${t.row_count.toLocaleString("ko-KR")}행`));
    card.appendChild(head);
    const cols = el("div", "cols");
    t.columns.forEach((c) => {
      const chip = el("code", "chip");
      chip.textContent = `${c.name} `;
      chip.appendChild(el("span", "muted", c.type));
      cols.appendChild(chip);
    });
    card.appendChild(cols);
    box.appendChild(card);
  }
}
