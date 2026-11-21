"""Vercel Python 런타임용 handler 클래스를 handle(payload) 함수에서 만들어 준다."""
import json
from http.server import BaseHTTPRequestHandler


def make_handler(handle):
    class handler(BaseHTTPRequestHandler):
        def do_POST(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(n) or b"{}")
            except (ValueError, json.JSONDecodeError):
                status, out = 400, {"error": "요청 본문이 JSON이 아닙니다"}
            else:
                status, out = handle(payload)
            body = json.dumps(out, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return handler
