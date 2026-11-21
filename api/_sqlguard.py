"""읽기 전용 SQL 검사 (Python 판). js/sqlguard.js 와 같은 규칙·같은 순서.

1단계 check_text  : 주석·문자열을 가린 뒤 한 문장인지, SELECT/WITH 로 시작하는지,
                    금지 키워드·파일 읽기 함수·FROM '파일경로' 가 없는지 본다.
2단계 check_ast   : DuckDB json_serialize_sql 로 구문 트리를 만들어
                    SELECT 문 1개인지, 읽는 테이블이 허용 목록(+CTE)에 있는지,
                    테이블 함수가 허용 목록에 있는지 본다. (duckdb 연결이 있을 때만)
"""
import json
import re
from pathlib import Path

RULES = json.loads((Path(__file__).resolve().parent.parent / "sqlguard_rules.json").read_text(encoding="utf-8"))


def _word(w):
    return re.compile(r"(?<![A-Za-z0-9_])" + re.escape(w) + r"(?![A-Za-z0-9_])", re.IGNORECASE)


_KW = [(k, _word(k)) for k in RULES["forbidden_keywords"]]
_FN = [(f, re.compile(r"(?<![A-Za-z0-9_])" + re.escape(f) + r"\s*\(", re.IGNORECASE)) for f in RULES["forbidden_functions"]]
_FROM_STR = re.compile(r"(?<![A-Za-z0-9_])(FROM|JOIN)\s+__STR__", re.IGNORECASE)


def mask(sql):
    """주석은 공백, '문자열' 은 __STR__, "식별자" 는 __ID__ 로 바꾼다. 닫히지 않으면 ValueError."""
    out, i, n = [], 0, len(sql)
    while i < n:
        c = sql[i]
        if sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j < 0 else j
            out.append(" ")
        elif sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            if j < 0:
                raise ValueError("닫히지 않은 주석이 있습니다")
            i = j + 2
            out.append(" ")
        elif c in ("'", '"'):
            j = i + 1
            while True:
                j = sql.find(c, j)
                if j < 0:
                    raise ValueError("닫히지 않은 따옴표가 있습니다")
                if j + 1 < n and sql[j + 1] == c:  # '' 또는 "" 이스케이프
                    j += 2
                    continue
                break
            out.append(" __STR__ " if c == "'" else " __ID__ ")
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def check_text(sql):
    """통과하면 None, 막히면 한국어 사유 문자열."""
    if not isinstance(sql, str) or not sql.strip():
        return "SQL이 비어 있습니다"
    if len(sql) > RULES["max_length"]:
        return "SQL이 너무 깁니다"
    try:
        m = mask(sql)
    except ValueError as e:
        return str(e)
    m = m.strip()
    while m.endswith(";"):
        m = m[:-1].rstrip()
    if ";" in m:
        return "한 번에 한 문장만 실행할 수 있습니다"
    first = re.match(r"[\s(]*([A-Za-z]+)", m)
    if not first or first.group(1).upper() not in RULES["allowed_start"]:
        return "읽기(SELECT · WITH)로 시작하는 SQL만 실행할 수 있습니다"
    for k, rx in _KW:
        if rx.search(m):
            return f"읽기 전용이 아닌 키워드({k})가 있습니다"
    for f, rx in _FN:
        if rx.search(m):
            return f"허용하지 않는 함수({f})가 있습니다"
    if _FROM_STR.search(m):
        return "파일 경로를 직접 읽을 수 없습니다. 올라와 있는 테이블만 쓸 수 있습니다"
    return None


def _walk(node, tables, funcs, ctes):
    if isinstance(node, dict):
        t = node.get("type")
        if t == "BASE_TABLE":
            tables.append((node.get("catalog_name") or "", node.get("schema_name") or "", node.get("table_name") or ""))
        elif t == "TABLE_FUNCTION":
            fn = (node.get("function") or {}).get("function_name") or ""
            funcs.append(fn)
        cm = node.get("cte_map")
        if isinstance(cm, dict):
            for e in cm.get("map", []):
                ctes.add(str(e.get("key", "")).lower())
        for v in node.values():
            _walk(v, tables, funcs, ctes)
    elif isinstance(node, list):
        for v in node:
            _walk(v, tables, funcs, ctes)


def check_ast(sql, conn, allowed_tables):
    """duckdb 연결로 구문 트리를 검사. 통과하면 None."""
    raw = conn.execute("SELECT json_serialize_sql(CAST(? AS VARCHAR))", [sql]).fetchone()[0]
    tree = json.loads(raw)
    if tree.get("error"):
        return "SELECT 문이 아니거나 구문 오류입니다: " + str(tree.get("error_message", ""))
    if len(tree.get("statements", [])) != 1:
        return "한 번에 한 문장만 실행할 수 있습니다"
    tables, funcs, ctes = [], [], set()
    _walk(tree, tables, funcs, ctes)
    allowed = {t.lower() for t in allowed_tables} | ctes
    for cat, sch, name in tables:
        if cat or sch or name.lower() not in allowed:
            return f"올라와 있지 않은 테이블({'.'.join(x for x in (cat, sch, name) if x)})을 읽으려 합니다"
    ok_fn = {f.lower() for f in RULES["allowed_table_functions"]}
    for fn in funcs:
        if fn.lower() not in ok_fn:
            return f"허용하지 않는 테이블 함수({fn})가 있습니다"
    return None


def check(sql, conn=None, allowed_tables=()):
    return check_text(sql) or (check_ast(sql, conn, allowed_tables) if conn is not None else None)
