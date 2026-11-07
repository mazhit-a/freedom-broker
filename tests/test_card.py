import re
from pathlib import Path

from tests.test_frontend import FRONTEND, client, frontend_files

COMPONENTS = ["cqa-conversation-card.js", "cqa-transcript.js", "cqa-evaluation-panel.js"]


def test_card_assets_served(client):
    for name in COMPONENTS:
        assert client.get("/app/js/components/" + name).status_code == 200, name


def test_card_components_shadow_dom_and_registered():
    for name in COMPONENTS:
        text = (FRONTEND / "js" / "components" / name).read_text(encoding="utf-8")
        assert "attachShadow" in text and "customElements.define" in text, name


def test_card_wiring_and_audio_endpoint_usage():
    app = (FRONTEND / "js" / "components" / "cqa-app.js").read_text(encoding="utf-8")
    assert "cqa-conversation-card" in app
    api = (FRONTEND / "js" / "api.js").read_text(encoding="utf-8")
    assert "/audio" in api
    transcript = (FRONTEND / "js" / "components" / "cqa-transcript.js").read_text(encoding="utf-8")
    assert '"m-"' in transcript


def test_no_comments_or_absolute_paths_in_card_sources():
    for name in COMPONENTS:
        text = (FRONTEND / "js" / "components" / name).read_text(encoding="utf-8")
        assert not re.search(r"^\s*//", text, re.M), name
        assert "/*" not in text and "<!--" not in text, name
        assert not re.search(r'["\'`]/(?:api|app|static)\b', text), name
