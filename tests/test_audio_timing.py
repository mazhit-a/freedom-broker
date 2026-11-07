import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.services.audio_timing import annotate_messages, compute_audio_timing

ROWS = [
    (0, "system", 0.19, "Запись и транскрибирование запущены."),
    (10, "bot", 52.458, "Продолжая разговор, вы соглашаетесь"),
    (11, "system", 52.794, "Клиент переведен от агента на представителя службы поддержки"),
    (12, "system", 53.712, "Запись и транскрибирование приостановлены."),
    (13, "system", 63.787, "Агент присоединился к разговору с клиентом."),
    (14, "system", 66.722, "Запись и транскрибирование возобновлены."),
    (15, "client", 70.297, "Ну в хабаровскомто."),
    (16, "operator", 72.483, "Компания Здравствуйте, чем могу вам помочь"),
    (17, "operator", 81.617, "Да."),
    (18, "client", 102.218, "Здравствуйте, мы с супругой на неё регистрируем"),
    (19, "operator", 107.314, "Так, а подскажете номер телефона"),
]


def fixture():
    return [{"message_index": i, "speaker": s, "offset_seconds": o, "text": t} for i, s, o, t in ROWS]


def test_pause_and_start_offset_applied():
    timing = compute_audio_timing(fixture())
    assert timing[16]["audio_start_seconds"] == pytest.approx(59.3, abs=0.5)
    assert timing[16]["audio_start_seconds"] == pytest.approx(72.483 - 13.01 - 0.19, abs=0.01)
    assert timing[0]["audio_end_seconds"] == 0
    assert timing[12]["audio_end_seconds"] == pytest.approx(53.522, abs=0.01)
    assert timing[13]["audio_end_seconds"] == pytest.approx(53.522, abs=0.01)


def test_start_estimated_from_previous_turn_end():
    timing = compute_audio_timing(fixture())
    assert timing[18]["audio_start_seconds"] == pytest.approx(timing[17]["audio_end_seconds"], abs=0.001)
    assert timing[18]["audio_start_seconds"] == pytest.approx(65, abs=5)
    assert timing[18]["audio_end_seconds"] == pytest.approx(102.218 - 13.01 - 0.19, abs=0.01)
    assert timing[18]["audio_start_seconds"] <= timing[18]["audio_end_seconds"]
    assert timing[19]["audio_start_seconds"] == pytest.approx(107.314 - 13.01 - 0.19, abs=0.01)
    assert timing[19]["audio_start_seconds"] == pytest.approx(97, abs=4)


def test_utterance_capped_at_sixty_seconds():
    messages = [{"message_index": 0, "speaker": "client", "offset_seconds": 100.0, "text": "x"}]
    timing = compute_audio_timing(messages)
    assert timing[0]["audio_start_seconds"] == 40.0
    assert timing[0]["audio_end_seconds"] == 100.0


def test_missing_start_text_falls_back_to_zero():
    messages = [
        {"message_index": 0, "speaker": "system", "offset_seconds": 0.0, "text": "Агент присоединился"},
        {"message_index": 1, "speaker": "operator", "offset_seconds": 5.0, "text": "Hi"},
    ]
    assert compute_audio_timing(messages)[1]["audio_start_seconds"] == 5.0


def test_unmatched_pause_and_null_offset():
    messages = [
        {"message_index": 0, "speaker": "operator", "offset_seconds": 10.0, "text": "a"},
        {"message_index": 1, "speaker": "system", "offset_seconds": 12.0, "text": "Запись приостановлена."},
        {"message_index": 2, "speaker": "client", "offset_seconds": 30.0, "text": "b"},
        {"message_index": 3, "speaker": "client", "offset_seconds": None, "text": "c"},
    ]
    timing = compute_audio_timing(messages)
    assert timing[2]["audio_end_seconds"] == 12.0
    assert timing[3] == {"audio_start_seconds": None, "audio_end_seconds": None}


def test_chat_gets_no_audio_fields():
    messages = fixture()
    out = annotate_messages(messages, "agent chat", None)
    assert all("audio_start_seconds" not in m and "audio_end_seconds" not in m for m in out)


def test_pause_free_voice_call_only_shifts_by_start():
    messages = [
        {"message_index": 0, "speaker": "system", "offset_seconds": 2.0, "text": "Запись и транскрибирование запущены."},
        {"message_index": 1, "speaker": "operator", "offset_seconds": 12.0, "text": "a"},
    ]
    out = annotate_messages(messages, "voice call", None)
    assert out[1]["audio_start_seconds"] == 10.0


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CQA_DB_PATH", str(tmp_path / "t.db"))
    config.get_settings.cache_clear()
    from backend.app.core.database import connect
    from backend.app.main import app

    with TestClient(app) as c:
        conn = connect()
        ds = conn.execute("INSERT INTO dataset (group_id) VALUES ('A')").lastrowid
        ids = {}
        for name, channel, url in (("call", "voice call", "https://player.example.test/play"), ("chat", "agent chat", None)):
            pk = conn.execute(
                "INSERT INTO conversation (dataset_id, conversation_id, channel, audio_url) VALUES (?,?,?,?)",
                (ds, name, channel, url),
            ).lastrowid
            ids[name] = pk
            for i, s, o, t in ROWS:
                conn.execute(
                    "INSERT INTO message (conversation_id, message_index, offset_seconds, speaker, text) VALUES (?,?,?,?,?)",
                    (pk, i, o, s, t),
                )
        conn.commit()
        c.ids = ids
        yield c


def test_api_returns_audio_fields_for_voice_only(client):
    call = client.get(f"/api/v1/conversations/{client.ids['call']}").json()
    by_index = {m["message_index"]: m for m in call["messages"]}
    assert by_index[16]["audio_start_seconds"] == pytest.approx(59.283, abs=0.01)
    assert by_index[18]["audio_start_seconds"] == pytest.approx(by_index[17]["audio_end_seconds"], abs=0.001)
    chat = client.get(f"/api/v1/conversations/{client.ids['chat']}").json()
    assert all("audio_start_seconds" not in m for m in chat["messages"])
