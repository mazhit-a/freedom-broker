import re
import sys

import httpx

from backend.app.core.config import get_settings
from backend.app.services import importer


def first_audio_url(group_id: str) -> str | None:
    _, records = importer.parse_payload(importer.fetch_payload(group_id))
    for record in records:
        if record.get("audio_url"):
            return record["audio_url"]
    return None


def resolve_media_url(url: str) -> tuple[str, dict]:
    info: dict = {}
    page = httpx.get(url, timeout=60, follow_redirects=True)
    info["audio_url_content_type"] = page.headers.get("content-type")
    info["audio_url_is_html_player_page"] = "text/html" in (page.headers.get("content-type") or "")
    if not info["audio_url_is_html_player_page"]:
        return url, info
    match = re.search(r'<source[^>]+src="([^"]+)"', page.text)
    if not match:
        raise SystemExit("Player page has no <source src>")
    media = match.group(1).replace("&amp;", "&")
    info["media_host"] = media.split("/")[2]
    expiry = re.search(r"[?&]se=([^&]+)", media)
    start = re.search(r"[?&]st=([^&]+)", media)
    info["media_url_is_time_limited_sas"] = bool(expiry)
    info["media_sas_start"] = start.group(1) if start else None
    info["media_sas_expiry"] = expiry.group(1) if expiry else None
    return media, info


def probe(page_url: str) -> dict:
    url, result = resolve_media_url(page_url)
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        head = client.head(url)
        result["head_status"] = head.status_code
        result["head_headers"] = {
            k: head.headers.get(k)
            for k in ("content-type", "content-length", "accept-ranges", "access-control-allow-origin", "content-disposition")
        }
        ranged = client.get(url, headers={"Range": "bytes=0-1023"})
        result["range_status"] = ranged.status_code
        result["range_content_range"] = ranged.headers.get("content-range")
        result["range_bytes_received"] = len(ranged.content)
        result["range_supported"] = ranged.status_code == 206
        cors = client.get(url, headers={"Origin": "http://localhost:8000", "Range": "bytes=0-15"})
        result["cors_allow_origin"] = cors.headers.get("access-control-allow-origin")
        result["cors_allow_headers"] = cors.headers.get("access-control-allow-headers")
        options = client.options(
            url,
            headers={
                "Origin": "http://localhost:8000",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "range",
            },
        )
        result["preflight_status"] = options.status_code
        result["preflight_allow_origin"] = options.headers.get("access-control-allow-origin")
    return result


if __name__ == "__main__":
    group = sys.argv[1] if len(sys.argv) > 1 else "DEV"
    if not get_settings().cqa_api_url:
        sys.exit("CQA_API_URL is not set")
    url = first_audio_url(group)
    if not url:
        sys.exit("No record with audio_url found")
    for key, value in probe(url).items():
        print(f"{key}: {value}")
