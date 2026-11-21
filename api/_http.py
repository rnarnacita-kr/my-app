"""Vercel Python 함수 공통: 요청 JSON 을 읽어 handle(payload) 에 넘기고 응답 JSON 을 쓴다.

Vercel 은 api/*.py 안의 `class handler(BaseHTTPRequestHandler)` 를 찾아 함수로 인식하므로,
각 API 파일에는 그 클래스를 글자 그대로 두고 do_POST 에서 respond() 를 부른다.
"""
import json


def respond(req, handle):
    try:
        n = int(req.headers.get("Content-Length") or 0)
        payload = json.loads(req.rfile.read(n) or b"{}")
    except (ValueError, json.JSONDecodeError):
        status, out = 400, {"error": "요청 본문이 JSON이 아닙니다"}
    else:
        status, out = handle(payload)
    body = json.dumps(out, ensure_ascii=False).encode("utf-8")
    req.send_response(status)
    req.send_header("Content-Type", "application/json; charset=utf-8")
    req.send_header("Content-Length", str(len(body)))
    req.end_headers()
    req.wfile.write(body)
