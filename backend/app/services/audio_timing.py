import re
from typing import Optional

MAX_UTTERANCE_SECONDS = 60.0
SPEAKING = ("operator", "client", "bot")

PAUSE_RE = re.compile(r"приостановлен|paused", re.I)
RESUME_RE = re.compile(r"возобновлен|resumed", re.I)
START_RE = re.compile(r"(?:запись|транскрибирование).*запущен|(?:recording|transcription).*started", re.I)


def is_voice(channel: Optional[str], audio_url: Optional[str] = None) -> bool:
    if audio_url:
        return True
    value = (channel or "").lower()
    return "voice" in value or "call" in value


def _speaker(message: dict) -> str:
    return (message.get("speaker") or "").strip().lower()


def _offset(message: dict) -> Optional[float]:
    value = message.get("offset_seconds")
    return float(value) if value is not None else None


def _pause_intervals(messages: list[dict]) -> list[tuple[float, float]]:
    intervals: list[tuple[float, float]] = []
    opened: Optional[float] = None
    for m in messages:
        offset = _offset(m)
        if offset is None or _speaker(m) != "system":
            continue
        text = m.get("text") or ""
        if RESUME_RE.search(text):
            if opened is not None:
                intervals.append((opened, max(offset, opened)))
                opened = None
        elif PAUSE_RE.search(text):
            if opened is None:
                opened = offset
    if opened is not None:
        intervals.append((opened, float("inf")))
    return intervals


def _recording_start(messages: list[dict]) -> float:
    for m in messages:
        offset = _offset(m)
        if offset is not None and _speaker(m) == "system" and START_RE.search(m.get("text") or ""):
            return offset
    return 0.0


def _paused_before(offset: float, intervals: list[tuple[float, float]]) -> float:
    total = 0.0
    for begin, end in intervals:
        if offset > begin:
            total += min(offset, end) - begin
    return total


def compute_audio_timing(messages: list[dict]) -> dict[int, dict]:
    ordered = sorted(messages, key=lambda m: m["message_index"])
    intervals = _pause_intervals(ordered)
    start_offset = _recording_start(ordered)
    start_audio = start_offset - _paused_before(start_offset, intervals)
    result: dict[int, dict] = {}
    previous_end = 0.0
    for m in ordered:
        offset = _offset(m)
        if offset is None:
            result[m["message_index"]] = {"audio_start_seconds": None, "audio_end_seconds": None}
            continue
        end = max(0.0, offset - _paused_before(offset, intervals) - start_audio)
        if _speaker(m) in SPEAKING:
            start = min(max(previous_end, end - MAX_UTTERANCE_SECONDS, 0.0), end)
            previous_end = max(previous_end, end)
        else:
            start = end
        result[m["message_index"]] = {
            "audio_start_seconds": round(start, 3),
            "audio_end_seconds": round(end, 3),
        }
    return result


def annotate_messages(messages: list[dict], channel: Optional[str], audio_url: Optional[str] = None) -> list[dict]:
    if not is_voice(channel, audio_url):
        return messages
    timing = compute_audio_timing(messages)
    return [{**m, **timing[m["message_index"]]} for m in messages]
