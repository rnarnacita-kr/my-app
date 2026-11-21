"""내 PC 용 개발 서버: 화면(정적 파일)과 api/ 함수를 한 포트(8780)에서 같이 띄운다.

    python tools/serve.py

- .env 의 KEY=VALUE 를 환경 변수로 넣는다(값은 출력하지 않는다).
- POST /api/<이름> → api/<이름>.py 의 handle(payload) 호출 (Vercel 과 같은 함수).
- .env · tools/ · api/ 소스 · 숨김 파일은 GET 으로 내주지 않는다.
"""
import importlib.util
import json
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 8780


def load_env(path):
    if not path.exists():
        print("[경고] .env 파일이 없습니다. GEMINI_API_KEY 가 없으면 AI 호출이 실패합니다.")
        return
    names = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if k.startswith("export "):
            k = k[7:].strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        os.environ.setdefault(k, v)
        names.append(k)
    print("[.env] 읽은 변수 이름:", ", ".join(names) or "(없음)")


_modules = {}


def api_module(name):
    if name not in _modules:
        path = ROOT / "api" / f"{name}.py"
        spec = importlib.util.spec_from_file_location(f"api_{name}", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _modules[name] = mod
    return _modules[name]


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".json": "application/json",
                      ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8",
                      ".wasm": "application/wasm"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _blocked(self):
        p = self.path.split("?", 1)[0]
        parts = [s for s in p.split("/") if s]
        return any(s.startswith(".") for s in parts) or (parts and parts[0] in ("api", "tools"))

    def do_GET(self):
        if self._blocked():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if self._blocked():
            self.send_error(404)
            return
        super().do_HEAD()

    def do_POST(self):
        p = self.path.split("?", 1)[0].strip("/").split("/")
        if len(p) != 2 or p[0] != "api" or not p[1].isidentifier() or p[1].startswith("_") \
                or not (ROOT / "api" / f"{p[1]}.py").exists():
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
            status, out = api_module(p[1]).handle(payload)
        except json.JSONDecodeError:
            status, out = 400, {"error": "요청 본문이 JSON이 아닙니다"}
        except Exception as e:  # 개발 서버: 오류를 화면에 그대로 알려 준다
            status, out = 500, {"error": f"{type(e).__name__}: {e}"}
        body = json.dumps(out, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    load_env(ROOT / ".env")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=str(ROOT)))
    print(f"열 주소: http://127.0.0.1:{PORT}  (끝내려면 Ctrl+C)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
