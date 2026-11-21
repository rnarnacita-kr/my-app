"""POST /api/sql — 한국어 질문을 DuckDB SQL 로 바꾼다.

받는 것: {"question": "..."}           (원본 행은 받지 않는다)
보내는 것: {"sql": "...", "basis": {...}, "model": "..."}
테이블 설명은 schema.json 하나만 쓴다.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _gemini  # noqa: E402
import _http  # noqa: E402
import _schema  # noqa: E402
import _sqlguard  # noqa: E402
MAX_QUESTION = 500

SYSTEM = """너는 온라인 쇼핑몰 매출 대사 데이터를 다루는 재무 분석가이자 DuckDB SQL 작성자다.
아래 [스키마]의 테이블만 써서 사용자의 한국어 질문에 답하는 DuckDB SQL 한 문장을 쓴다.

규칙:
- SELECT 또는 WITH 로 시작하는 읽기 SQL 한 문장만 쓴다. 세미콜론으로 여러 문장을 쓰지 않는다.
- [스키마]에 없는 테이블·컬럼, 파일 경로, read_csv 같은 파일 읽기 함수는 쓰지 않는다.
- 질문에 나온 지표는 [스키마]의 metrics 정의를 그대로 따른다. 특히
  · 주문 매출 = mall_orders.sales_amount 합, 주문일(order_date) 기준
  · 출고 매출 = shipments.ship_qty × mall_orders.unit_price 합 (order_no + line_no 조인), 출고일(ship_date) 기준
- 지표마다 자기 기준 날짜로 따로 거른다. 주문 매출은 order_date, 출고 매출은 ship_date 로 거른다.
  두 지표를 한 WHERE 로 같이 거르지 말고, 지표별 서브쿼리나 CTE 로 나눠 계산한다.
  (질문의 "12월 주문 기준 매출과 출고 기준 매출"은 주문일 12월의 주문 매출과 출고일 12월의 출고 매출이다)
- 질문에 없는 분해(쇼핑몰별·상품별 등)는 하지 않는다.
- 날짜 구간은 >= 시작일 AND < 다음 구간 시작일 형태로 쓴다.
- 결과 컬럼 별칭은 한국어로, 큰따옴표로 감싼다 (예: AS "주문 매출").
- 결과는 사람이 읽을 집계 결과여야 한다. 원본 행을 그대로 나열하지 말고 필요하면 ORDER BY 와 LIMIT 를 쓴다.

출력은 JSON 객체 하나:
{"sql": "<DuckDB SQL>",
 "basis": {"tables": ["읽은 테이블"], "filters": ["적용한 조건(기간·조인 키 등)"], "metrics": ["사용한 지표 이름(스키마 metrics 의 name)"]}}
basis 규칙:
- tables 에는 SQL 의 FROM/JOIN 에 실제로 쓴 테이블 이름을 스키마 표기 그대로 빠짐없이 쓴다(CTE 이름은 빼고).
- filters 는 사람이 읽을 한국어 문장으로 쓴다 (예: "주문일 2025-12-01 이상 2026-01-01 미만").
- metrics 에는 스키마 metrics 의 name 을 글자 그대로 쓴다. 해당하는 지표가 없으면 빈 목록.
"""


def handle(payload):
    """(HTTP 상태 코드, 응답 dict) 를 돌려준다. tools/serve.py 와 Vercel handler 가 같이 쓴다."""
    q = (payload or {}).get("question")
    if not isinstance(q, str) or not q.strip():
        return 400, {"error": "질문이 비어 있습니다"}
    q = q.strip()[:MAX_QUESTION]
    schema = _schema.schema_with((payload or {}).get("extra_tables"))
    user = "[스키마]\n" + json.dumps(schema, ensure_ascii=False) + "\n\n[질문]\n" + q
    try:
        out = _gemini.generate_json(SYSTEM, user)
    except _gemini.GeminiError as e:
        return 502, {"error": str(e)}
    sql = (out.get("sql") or "").strip() if isinstance(out, dict) else ""
    basis = out.get("basis") if isinstance(out, dict) else None
    reason = _sqlguard.check_text(sql)
    if reason:
        return 422, {"error": "AI가 쓴 SQL이 읽기 전용 검사에서 막혔습니다: " + reason, "sql": sql}
    return 200, {"sql": sql, "basis": basis or {}, "model": _gemini.model_name()}


class handler(BaseHTTPRequestHandler):  # Vercel Python 런타임 진입점
    def do_POST(self):
        _http.respond(self, handle)
