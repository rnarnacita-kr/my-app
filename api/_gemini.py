"""Gemini REST 호출 공통 함수. 외부 패키지 없이 urllib 만 쓴다.

키: 환경 변수 GEMINI_API_KEY / 모델: GEMINI_MODEL (없으면 gemini-3.5-flash-lite)
"""
import json
import os
import urllib.error
import urllib.request

DEFAULT_MODEL = "gemini-3.5-flash-lite"
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class GeminiError(Exception):
    pass


def model_name():
    return os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL


def generate_json(system_text, user_text, timeout=60):
    """system/user 텍스트를 보내고 JSON 객체로 받은 응답을 dict 로 돌려준다."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise GeminiError("GEMINI_API_KEY 환경 변수가 없습니다")
    body = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
    }
    req = urllib.request.Request(
        ENDPOINT.format(model=model_name()),
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise GeminiError(f"Gemini 호출 실패 (HTTP {e.code}): {detail}") from None
    except urllib.error.URLError as e:
        raise GeminiError(f"Gemini 연결 실패: {e.reason}") from None

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
