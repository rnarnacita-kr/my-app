"""AI 에 보내는 테이블 설명 = schema.json + 브라우저가 알려 준 '올린 테이블' 설명.

올린 테이블 설명은 이름 · 컬럼 이름 · 타입 · 행 수뿐이다(행 내용 없음, 컬럼 뜻 없음).
- schema.json 에 같은 이름이 있고 컬럼 이름이 같으면: 뜻은 그대로 두고 행 수만 새 값으로, 출처를 '올린 파일'로 표시
- 같은 이름인데 컬럼이 다르면: 그 테이블 설명을 올린 파일 기준(뜻 없음)으로 바꾼다
- 새 이름이면: 뜻 없는 테이블로 더한다
"""
import copy
import json
from pathlib import Path

SCHEMA = json.loads((Path(__file__).resolve().parent.parent / "schema.json").read_text(encoding="utf-8"))
MAX_TABLES = 30
MAX_COLS = 200
MAX_NAME = 100


def _clean(extra):
    out = []
    if not isinstance(extra, list):
        return out
    for t in extra[:MAX_TABLES]:
        if not isinstance(t, dict) or not isinstance(t.get("name"), str) or not t["name"].strip():
            continue
        cols = []
        for c in (t.get("columns") or [])[:MAX_COLS]:
            if isinstance(c, dict) and isinstance(c.get("name"), str):
                cols.append({"name": c["name"][:MAX_NAME], "type": str(c.get("type") or "")[:40]})
        rc = t.get("row_count")
        out.append({"name": t["name"].strip()[:MAX_NAME], "row_count": rc if isinstance(rc, int) else None, "columns": cols})
    return out


def schema_with(extra):
    s = copy.deepcopy(SCHEMA)
    by_name = {t["name"].lower(): t for t in s["tables"]}
    for u in _clean(extra):
        base = by_name.get(u["name"].lower())
        if base and [c["name"].lower() for c in base["columns"]] == [c["name"].lower() for c in u["columns"]]:
            base["row_count"] = u["row_count"]
            base["source"] = "사용자가 올린 파일로 바뀐 테이블 (컬럼 구성은 데이터 사전과 같음)"
            continue
        entry = {
            "name": u["name"],
            "source": "사용자가 올린 파일 (컬럼 뜻 정보 없음 — 이름과 타입으로만 판단)",
            "row_count": u["row_count"],
            "columns": u["columns"],
        }
        if base:
            s["tables"][s["tables"].index(base)] = entry
        else:
            s["tables"].append(entry)
        by_name[u["name"].lower()] = entry
    return s
