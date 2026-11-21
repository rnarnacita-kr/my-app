"""POST /api/why — 결과를 한 번 더 쪼개는 '원인 SQL' 을 쓴다.

받는 것: {"question", "sql", "columns": [...], "rows": [[...], ...]}  (원래 집계 결과, 50행 이하)
보내는 것: {"drill_sql", "dimension_cols", "measure_col", "note", "model"}
가장 큰 덩어리와 비중은 브라우저가 원인 SQL 결과에서 직접 계산한다(AI 는 숫자를 말하지 않는다).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _gemini  # noqa: E402
import _http  # noqa: E402
import _schema  # noqa: E402
import _sqlguard  # noqa: E402
MAX_ROWS = 50
MAX_COLS = 30
MAX_CELL = 200

SYSTEM = """너는 온라인 쇼핑몰 매출 대사 데이터를 다루는 재무 분석가이자 DuckDB SQL 작성자다.
사용자의 질문, 그 질문에 답한 원래 SQL, 원래 결과(집계, 최대 50행)를 받는다.
원래 결과가 왜 그렇게 나왔는지 한 단계 더 쪼개 보는 '원인 SQL' 한 문장을 쓴다.

원인 SQL 규칙:
- SELECT 또는 WITH 로 시작하는 DuckDB 읽기 SQL 한 문장. [스키마]의 테이블·컬럼만 쓴다. 파일 읽기 함수 금지.
- 원래 결과보다 한 단계 더 잘게 쪼갠다. 질문에 쪼갤 기준(예: 상품별)이 있으면 그 기준을 쓴다.
  예) 주문 매출과 출고 매출의 차이 → 쇼핑몰별 · 주문일 구간별(월초/중순/월말, 연말 프로모션 등) 차이
  예) 미출고 수량 비율이 높다 → 상품별 미출고 수량
- 쪼갠 기준 컬럼(dimension) 1~2개 + 측정값 컬럼(measure) 1개는 반드시 있어야 한다. 이해를 돕는 보조 컬럼은 더 둬도 된다.
- measure 는 그룹끼리 더할 수 있는 양(수량·금액·차이 금액)이어야 한다. 비율·평균은 measure 로 쓰지 않는다(보조 컬럼으로는 가능).
- 지표는 [스키마] metrics 정의를 그대로 따른다(주문 매출은 주문일 기준, 출고 매출은 출고일 기준, 미출고 수량 = 주문 수량 − 출고 수량, 출고 행이 없으면 출고 수량 0).
- 원래 SQL 의 기간·쇼핑몰 등 조건은 그대로 유지한다.
- 그룹 하나당 한 행. ORDER BY measure DESC. LIMIT 는 쓰지 않는다(브라우저가 전체 합으로 비중을 계산한다).
- 컬럼 별칭은 한국어로, 큰따옴표로 감싼다.

출력은 JSON 객체 하나:
{"drill_sql": "<DuckDB SQL>",
 "dimension_cols": ["쪼갠 기준 컬럼 별칭(결과 컬럼 이름 그대로)"],
 "measure_col": "측정값 컬럼 별칭(결과 컬럼 이름 그대로)",
 "note": "이 쪼개기가 무엇을 보여 주는지 한 문장. 숫자는 쓰지 않는다"}
"""


def _cell(v):
    if v is None or isinstance(v, (int, float, bool)):
        return v
    return str(v)[:MAX_CELL]


def handle(payload):
    p = payload or {}
    q, sql = p.get("question"), p.get("sql")
    if not isinstance(q, str) or not q.strip():
        return 400, {"error": "질문이 비어 있습니다"}
    if not isinstance(sql, str) or not sql.strip():
        return 400, {"error": "원래 SQL이 비어 있습니다"}
    cols = [str(c)[:MAX_CELL] for c in (p.get("columns") or [])][:MAX_COLS]
    rows = p.get("rows") or []
    if not isinstance(rows, list):
        return 400, {"error": "rows 형식이 잘못됐습니다"}
    # 서버에서도 50행으로 자른다(집계 결과만, 원본 행은 받지 않는다는 약속을 한 번 더 지킨다).
    rows = [[_cell(v) for v in (r if isinstance(r, list) else [])][:MAX_COLS] for r in rows[:MAX_ROWS]]

    user = (
        "[스키마]\n" + json.dumps(_schema.schema_with(p.get("extra_tables")), ensure_ascii=False)
        + "\n\n[질문]\n" + q.strip()[:500]
        + "\n\n[원래 SQL]\n" + sql.strip()[:20000]
        + "\n\n[원래 결과] (최대 50행)\n" + json.dumps({"columns": cols, "rows": rows}, ensure_ascii=False)
    )
    try:
        out = _gemini.generate_json(SYSTEM, user)
    except _gemini.GeminiError as e:
        return 502, {"error": str(e)}
    if not isinstance(out, dict):
        return 502, {"error": "AI 응답 형식이 잘못됐습니다"}
    drill = (out.get("drill_sql") or "").strip()
    measure = out.get("measure_col")
    dims = out.get("dimension_cols") or []
    if not isinstance(measure, str) or not measure or not isinstance(dims, list):
        return 502, {"error": "AI가 측정값/기준 컬럼을 알려 주지 않았습니다", "drill_sql": drill}
    reason = _sqlguard.check_text(drill)
    if reason:
        return 422, {"error": "AI가 쓴 원인 SQL이 읽기 전용 검사에서 막혔습니다: " + reason, "drill_sql": drill}
    return 200, {
        "drill_sql": drill,
        "dimension_cols": [str(d) for d in dims],
        "measure_col": measure,
        "note": str(out.get("note") or ""),
        "model": _gemini.model_name(),
    }


handler = _http.make_handler(handle)  # Vercel Python 런타임 진입점
