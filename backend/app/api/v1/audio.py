import html
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse, StreamingResponse

from backend.app.core.database import get_db

router = APIRouter(tags=["audio"])

SOURCE_RE = re.compile(r"<source[^>]+src=[\"']([^\"']+)[\"']", re.I)
PASS_HEADERS = ("content-type", "content-length", "content-range", "accept-ranges")


def make_client() -> httpx.Client:
    return httpx.Client(timeout=30.0, follow_redirects=True)


def resolve_media_url(client: httpx.Client, audio_url: str) -> str:
    try:
        page = client.get(audio_url)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Recording page is unreachable: " + str(exc))
    if page.status_code >= 400:
        raise HTTPException(status_code=502, detail="Recording page returned HTTP " + str(page.status_code))
    match = SOURCE_RE.search(page.text)
    if not match:
        raise HTTPException(status_code=502, detail="Recording page has no audio source")
    return html.unescape(match.group(1))


def _audio_url(conn, conversation_pk: int) -> str:
    row = conn.execute("SELECT audio_url FROM conversation WHERE id = ?", (conversation_pk,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if not row["audio_url"]:
        raise HTTPException(status_code=404, detail="Conversation has no recording")
    return row["audio_url"]


@router.get("/conversations/{conversation_pk}/audio")
def get_audio(conversation_pk: int, request: Request, mode: str = "redirect", conn=Depends(get_db)):
    audio_url = _audio_url(conn, conversation_pk)
    conn.close()
    client = make_client()
    try:
        media_url = resolve_media_url(client, audio_url)
        if mode != "proxy":
            client.close()
            return RedirectResponse(media_url, status_code=302, headers={"Cache-Control": "no-store"})
        headers = {}
        if request.headers.get("range"):
            headers["Range"] = request.headers["range"]
        try:
            upstream = client.send(client.build_request("GET", media_url, headers=headers), stream=True)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail="Recording is unreachable: " + str(exc))
    except BaseException:
        client.close()
        raise
    if upstream.status_code >= 400 and upstream.status_code != 416:
        upstream.close()
        client.close()
        raise HTTPException(status_code=502, detail="Recording returned HTTP " + str(upstream.status_code))

    def body():
        try:
            for chunk in upstream.iter_bytes(65536):
                yield chunk
        finally:
            upstream.close()
            client.close()

    out = {k.lower(): v for k, v in upstream.headers.items() if k.lower() in PASS_HEADERS}
    out.setdefault("accept-ranges", "bytes")
    out.setdefault("content-type", "audio/mpeg")
    out["cache-control"] = "no-store"
    return StreamingResponse(body(), status_code=upstream.status_code, headers=out)
