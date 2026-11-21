"""Gemini REST 호출 공통 함수. 외부 패키지 없이 urllib 만 쓴다.

키: 환경 변수 GEMINI_API_KEY
모델: GEMINI_MODEL (없으면 gemini-3.5-flash-lite)
예비 모델: GEMINI_FALLBACK_MODEL (선택) — 주 모델이 끝내 붐빌 때 한 번 더 시도할 모델

일시적 오류(429 · 500 · 502 · 503 · 504, 연결 끊김)는 잠깐 쉬었다가 다시 시도한다.
Vercel 함수 제한(60초) 안에 끝나도록 전체 시간 예산(TOTAL_BUDGET)을 넘기지 않는다.
"""
import json
import os
import socket
import time
import urllib.error
import urllib.request

DEFAULT_MODEL = "gemini-3.5-flash-lite"
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

RETRY_STATUS = {429, 500, 502, 503, 504}
MAX_ATTEMPTS = 3          # 모델 하나당 시도 횟수
BACKOFF = (1.5, 3.0)      # 다시 시도하기 전 쉬는 초 (1회차 뒤, 2회차 뒤)
TOTAL_BUDGET = 50.0       # 모든 시도를 합친 최대 초 (Vercel maxDuration 60초보다 짧게)
MIN_CALL_TIME = 8.0       # 남은 시간이 이보다 적으면 새로 시도하지 않는다

BUSY_MESSAGE = ("AI 모델에 요청이 몰려 지금은 답을 받지 못했습니다 (Gemini {code}). "
                "잠시 뒤 다시 눌러 주세요.")


class GeminiError(Exception):
    pass


class _Retryable(Exception):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def model_name():
    return os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL


def _models():
    main = model_name()
    fb = (os.environ.get("GEMINI_FALLBACK_MODEL") or "").strip()
    return [main] + ([fb] if fb and fb != main else [])


def _call(model, body, key, timeout):
    req = urllib.request.Request(
        ENDPOINT.format(model=model),
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        if e.code in RETRY_STATUS:
            raise _Retryable(e.code, detail) from None
        raise GeminiError(f"Gemini 호출 실패 (HTTP {e.code}): {detail}") from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:
        raise _Retryable("연결", str(getattr(e, "reason", e))) from None


def generate_json(system_text, user_text):
    """system/user 텍스트를 보내고 JSON 객체로 받은 응답을 dict 로 돌려준다."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise GeminiError("GEMINI_API_KEY 환경 변수가 없습니다")
    body = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
    }

    start = time.monotonic()
    last = None
    data = None
    for model in _models():
        for attempt in range(MAX_ATTEMPTS):
            remaining = TOTAL_BUDGET - (time.monotonic() - start)
            if remaining < MIN_CALL_TIME:
                break
            try:
                data = _call(model, body, key, timeout=remaining)
                break
            except _Retryable as e:
                last = e
                wait = BACKOFF[min(attempt, len(BACKOFF) - 1)]
                if attempt < MAX_ATTEMPTS - 1 and TOTAL_BUDGET - (time.monotonic() - start) - wait >= MIN_CALL_TIME:
                    time.sleep(wait)
        if data is not None:
            break
    if data is None:
        code = getattr(last, "code", "응답 없음")
        raise GeminiError(BUSY_MESSAGE.format(code=code))

    try:
        parts = data["candidates"][0]["content"]["parts"]
        text = "".join(p.get("text", "") for p in parts).strip()
    except (KeyError, IndexError):
        raise GeminiError("Gemini 응답에 내용이 없습니다: " + json.dumps(data, ensure_ascii=False)[:300]) from None
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{"):]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise GeminiError("Gemini 응답이 JSON이 아닙니다: " + text[:300]) from None
