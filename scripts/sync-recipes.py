#!/usr/bin/env python3
"""Fetch the official food-safety recipe data and publish a static snapshot.

No key is required for the default, documented five-record sample. Full imports
must be requested explicitly with --full and FOODSAFETY_API_KEY in the environment.
An existing full snapshot requires --full to refresh or --sample to replace it.
This script uses only Python's standard library and does not print request URLs.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
API_ROOT = "https://openapi.foodsafetykorea.go.kr/api"
SERVICE = "COOKRCP01"
SAMPLE_URL = f"{API_ROOT}/sample/{SERVICE}/json/1/5"
DOCS_URL = (
    "https://www.foodsafetykorea.go.kr/api/openApiInfo.do"
    "?menu_grp=MENU_GRP31&menu_no=661&show_cnt=10&start_idx=1&svc_no=COOKRCP01"
)
CATALOG_URL = "https://www.data.go.kr/data/15060073/openapi.do"
GROUP_NAMES = {
    "고명", "양념", "양념장", "양념재료", "양념 재료", "소스", "소스재료",
    "소스 재료", "주재료", "부재료", "재료", "국물", "육수", "반죽",
}
AMOUNT_RE = re.compile(
    r"(?<!\S)(?:\d+(?:\.\d+)?(?:/\d+)?(?:\s*[~∼–-]\s*\d+(?:\.\d+)?)?"
    r"|[¼½¾⅓⅔⅛⅜⅝⅞])\s*"
    r"(?:kg|mg|g|mL|ml|L|l|ℓ|큰술|작은술|큰\s*술|작은\s*술|컵|개|알|줄기|송이|"
    r"마리|모|봉지|봉|장|쪽|대|포기|뿌리|조각|줌|공기|근|스푼|tsp|tbsp|T|t)"
)
ATTACHED_AMOUNT_RE = re.compile(
    r"(?<![\d./])" + AMOUNT_RE.pattern.removeprefix(r"(?<!\S)")
)
BRACKET_PAIRS = {"(": ")", "[": "]", "{": "}", "（": "）", "［": "］"}


class SyncError(Exception):
    """An error whose message is safe to print without an API key."""


def fetch_page(url: str) -> tuple[dict[str, Any], list[dict[str, Any]], int]:
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "foodhannun/1.0"},
    )
    try:
        with urlopen(request, timeout=45) as response:
            payload = response.read(40 * 1024 * 1024 + 1)
    except HTTPError as exc:
        raise SyncError(f"공식 API 요청에 실패했습니다 (HTTP {exc.code}).") from None
    except (URLError, TimeoutError, OSError):
        raise SyncError("공식 API에 연결하지 못했습니다. 네트워크와 인증 설정을 확인하세요.") from None
    if len(payload) > 40 * 1024 * 1024:
        raise SyncError("API 응답이 예상 크기를 초과했습니다. 기존 파일을 보존합니다.")
    try:
        raw = json.loads(payload.decode("utf-8-sig"))
        body = raw[SERVICE]
        result = body.get("RESULT", raw.get("RESULT", {}))
        code = str(result.get("CODE", ""))
        if code != "INFO-000":
            safe_code = code if re.fullmatch(r"[A-Z0-9-]{1,32}", code) else "UNKNOWN"
            raise SyncError(f"공식 API가 정상 데이터를 반환하지 않았습니다 ({safe_code}).")
        rows = body["row"]
        total = int(body["total_count"])
    except SyncError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError):
        raise SyncError("공식 API 응답 형식이 올바르지 않습니다. 기존 파일을 보존합니다.") from None
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise SyncError("공식 API의 레시피 목록 형식이 올바르지 않습니다.")
    if total < 0 or len(rows) > total:
        raise SyncError("공식 API의 전체 레시피 수가 올바르지 않습니다.")
    return raw, rows, total


def https_image(value: Any) -> str:
    """Use HTTPS for the image addresses supplied by the source."""
    value = str(value or "").strip()
    if not value:
        return ""
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https"):
        return ""
    return urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, parsed.fragment))


def numeric(value: Any) -> int | float | None:
    text = "" if value is None else str(value).strip()
    if not text:
        return None
    try:
        number = float(text)
    except (ValueError, TypeError):
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else number


def split_ingredients(text: str) -> list[str]:
    """Split commas and newlines except those inside parentheses or brackets."""
    pieces: list[str] = []
    current: list[str] = []
    depth = 0
    for char in text.replace("\r\n", "\n").replace("\r", "\n"):
        if char in "([{（［":
            depth += 1
        elif char in ")]}）］":
            depth = max(0, depth - 1)
        if char in ",\n" and depth == 0:
            if "".join(current).strip():
                pieces.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    if "".join(current).strip():
        pieces.append("".join(current).strip())
    return pieces


def balanced_brackets(text: str, single_group: bool = False) -> bool:
    """Validate grouping without repairing or deleting any source characters."""
    if single_group and (not text or text[0] not in BRACKET_PAIRS):
        return False
    stack: list[str] = []
    for index, char in enumerate(text):
        if char in BRACKET_PAIRS:
            stack.append(BRACKET_PAIRS[char])
        elif char in BRACKET_PAIRS.values():
            if not stack or stack.pop() != char:
                return False
        if single_group and not stack and index != len(text) - 1:
            return False
    return not stack


def split_attached_amount(candidate: str) -> tuple[str, str] | None:
    """Split one clear quantity, preserving its original notation and grouping.

    Examples: '두부200g', '두부(200g)', '두부(200g, 1/2모)'. Do not
    reinterpret unmatched brackets or strings containing multiple ingredients.
    """
    match = ATTACHED_AMOUNT_RE.search(candidate)
    if not match:
        return None
    prefix = candidate[:match.start()].rstrip()
    if not prefix:
        return None
    if prefix[-1] in ("(", "（"):
        start = len(prefix) - 1
        name, amount = candidate[:start].strip(), candidate[start:].strip()
        if name and balanced_brackets(name) and balanced_brackets(amount, single_group=True):
            return name, amount
        return None
    if not balanced_brackets(prefix):
        return None
    remainder = candidate[match.end():].strip()
    if remainder and not balanced_brackets(remainder, single_group=True):
        return None
    return prefix, candidate[match.start():].strip()


def parse_ingredients(text: str, recipe_name: str) -> list[dict[str, str]]:
    ingredients: list[dict[str, str]] = []
    compact_title = re.sub(r"\s+", "", recipe_name)
    for raw in split_ingredients(text):
        candidate = raw.lstrip(" ·●•-*\t").strip()
        candidate = re.sub(r"(?:\s*<br\s*/?>)+\s*$", "", candidate, flags=re.IGNORECASE).strip()
        candidate = re.sub(r"^\[[^\]]*인분\s*\]\s*", "", candidate)
        if ":" in candidate or "：" in candidate:
            heading, _, rest = re.split(r"([:：])", candidate, maxsplit=1)
            if not re.search(r"\d", heading):
                candidate = rest.strip()
        candidate = candidate.strip()
        if not candidate or candidate in GROUP_NAMES:
            continue
        compact = re.sub(r"\s+", "", candidate)
        if compact == compact_title:
            continue
        # The official sample uses a short dish title such as '북엇국' as a
        # separate heading before the ingredient line.
        if (not re.search(r"\d", candidate) and compact_title.endswith(compact)
                and candidate.endswith(("국", "찜", "무침", "소박이", "소스"))):
            continue
        attached = split_attached_amount(candidate)
        match = AMOUNT_RE.search(candidate)
        if attached:
            name, amount = attached
        elif match:
            name, amount = candidate[:match.start()].strip(), candidate[match.start():].strip()
        else:
            verbal = re.search(r"\s+(약간|적당량|조금|기호에\s*따라.*)$", candidate)
            if verbal:
                name, amount = candidate[:verbal.start()].strip(), verbal.group(1).strip()
            else:
                name, amount = candidate, ""
        if name:
            ingredients.append({"name": name, "amount": amount, "raw": raw})
    return ingredients


def clean_step(text: str) -> str:
    """Keep cooking instructions; remove only source numbering/image markers."""
    text = re.sub(r"^\s*\d+\s*[.)]\s*", "", text).strip()
    return re.sub(r"(?<=[.!?])\s*[a-z]\s*$", "", text).strip()


def transform(row: dict[str, Any]) -> dict[str, Any]:
    recipe_id = str(row.get("RCP_SEQ", "")).strip()
    name = str(row.get("RCP_NM", "")).strip()
    if not recipe_id or not name or not re.fullmatch(r"[0-9]+", recipe_id):
        raise SyncError("ID 또는 음식명이 누락된 레시피가 있습니다. 기존 파일을 보존합니다.")
    ingredient_text = str(row.get("RCP_PARTS_DTLS") or "")
    steps = []
    for number in range(1, 21):
        raw = str(row.get(f"MANUAL{number:02d}") or "")
        if raw.strip():
            steps.append({
                "number": number,
                "text": clean_step(raw),
                "image": https_image(row.get(f"MANUAL_IMG{number:02d}")),
                "raw": raw,
            })
    image = https_image(row.get("ATT_FILE_NO_MK") or row.get("ATT_FILE_NO_MAIN"))
    for extension in ("webp", "png", "jpg"):
        relative = f"assets/images/recipe-{recipe_id}.{extension}"
        if (ROOT / relative).is_file():
            image = relative
            break
    return {
        "id": recipe_id,
        "name": name,
        "category": str(row.get("RCP_PAT2") or ""),
        "method": str(row.get("RCP_WAY2") or ""),
        "ingredientText": ingredient_text,
        "ingredients": parse_ingredients(ingredient_text, name),
        "steps": steps,
        "nutrition": {
            "energy": numeric(row.get("INFO_ENG")),
            "carbohydrates": numeric(row.get("INFO_CAR")),
            "protein": numeric(row.get("INFO_PRO")),
            "fat": numeric(row.get("INFO_FAT")),
            "sodium": numeric(row.get("INFO_NA")),
            "weight": numeric(row.get("INFO_WGT")),
        },
        "image": image,
        "tag": str(row.get("HASH_TAG") or ""),
    }


def atomic_write_all(outputs: dict[Path, str]) -> None:
    """Stage every output after a complete fetch; replace each file atomically."""
    staged: list[tuple[Path, Path]] = []
    try:
        for destination, contents in outputs.items():
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=destination.parent,
                prefix=f".{destination.name}.", suffix=".tmp", delete=False,
            ) as temporary:
                temporary.write(contents)
                temporary.flush()
                os.fsync(temporary.fileno())
                staged.append((Path(temporary.name), destination))
        for temporary, destination in staged:
            os.replace(temporary, destination)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--full", action="store_true", help="환경변수의 인증키로 전체 레시피 수집")
    mode.add_argument("--sample", action="store_true", help="공식 샘플 5건으로 명시적으로 전환 또는 갱신")
    args = parser.parse_args()
    if not args.full and not args.sample:
        existing_path = ROOT / "data" / "recipes.json"
        if existing_path.exists():
            try:
                existing_mode = json.loads(existing_path.read_text(encoding="utf-8")).get("meta", {}).get("datasetMode")
            except (OSError, ValueError, TypeError, AttributeError):
                print("오류: 기존 데이터 모드를 확인하지 못했습니다. --full 또는 --sample을 명시하세요. 기존 파일을 보존합니다.", file=sys.stderr)
                return 2
            if existing_mode == "official-full":
                print("오류: 전체 레시피가 저장되어 있습니다. 갱신은 --full, 샘플 5건으로 전환은 --sample을 명시하세요. 기존 파일을 보존합니다.", file=sys.stderr)
                return 2
    api_key = os.environ.get("FOODSAFETY_API_KEY", "").strip() if args.full else ""
    if args.full and not api_key:
        print("오류: --full은 FOODSAFETY_API_KEY 환경변수가 필요합니다. 기존 파일을 보존합니다.", file=sys.stderr)
        return 2
    try:
        if args.full:
            encoded_key = quote(api_key, safe="")
            first_url = f"{API_ROOT}/{encoded_key}/{SERVICE}/json/1/1000"
            raw, rows, total = fetch_page(first_url)
            expected = min(1000, total)
            if not total or len(rows) != expected:
                raise SyncError("첫 페이지 데이터가 완전하지 않습니다. 기존 파일을 보존합니다.")
            for start in range(1001, total + 1, 1000):
                end = min(start + 999, total)
                _, page_rows, page_total = fetch_page(
                    f"{API_ROOT}/{encoded_key}/{SERVICE}/json/{start}/{end}"
                )
                if page_total != total or len(page_rows) != end - start + 1:
                    raise SyncError("수집 도중 데이터 개수 변경 또는 누락이 발생했습니다. 기존 파일을 보존합니다.")
                rows.extend(page_rows)
            raw[SERVICE]["row"] = rows
            mode, raw_name = "official-full", "raw-full.json"
        else:
            raw, rows, total = fetch_page(SAMPLE_URL)
            if len(rows) != 5:
                raise SyncError("공식 샘플 5건을 모두 받지 못했습니다. 기존 파일을 보존합니다.")
            mode, raw_name = "official-sample", "raw-sample.json"

        recipes = [transform(row) for row in rows]
        if len({recipe["id"] for recipe in recipes}) != len(recipes):
            raise SyncError("중복된 레시피 ID가 있습니다. 기존 파일을 보존합니다.")
        snapshot = {
            "meta": {
                "sourceName": "식품안전나라 조리식품의 레시피 DB",
                "sourceUrl": CATALOG_URL,
                "apiDocsUrl": DOCS_URL,
                "licenseUrl": CATALOG_URL,
                "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                "datasetMode": mode,
                "count": len(recipes),
                "totalAvailable": total,
            },
            "recipes": recipes,
        }
        json_text = json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n"
        # Escaping these characters also keeps the generated JavaScript safe if
        # a consumer later embeds it in a script element.
        script_json = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
        script_json = script_json.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        outputs = {
            ROOT / "data" / "recipes.json": json_text,
            ROOT / "assets" / "data.js": "/* Official recipe snapshot. Regenerate with scripts/sync-recipes.py. */\nwindow.FOOD_DATA = " + script_json + ";\n",
            ROOT / "data" / raw_name: json.dumps(raw, ensure_ascii=False, indent=2) + "\n",
        }
        if api_key:
            # Request keys are never placed in the files, including if an
            # unexpected API response were to echo credentials in a field.
            for contents in outputs.values():
                if api_key in contents or encoded_key in contents:
                    raise SyncError("API 응답에 인증 정보가 포함되어 저장을 중단했습니다.")
        atomic_write_all(outputs)
    except SyncError as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 1
    except OSError:
        print("오류: 스냅샷 파일을 저장하지 못했습니다. 파일 권한과 저장 공간을 확인하세요.", file=sys.stderr)
        return 1
    print(f"완료: {len(recipes)}개 공식 레시피 저장 ({mode}, 전체 제공 수 {total}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
