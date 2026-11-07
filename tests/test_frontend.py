import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CQA_DB_PATH", str(tmp_path / "t.db"))
    config.get_settings.cache_clear()
    from backend.app.main import app

    with TestClient(app) as c:
        yield c
    config.get_settings.cache_clear()


def frontend_files():
    return [p for p in FRONTEND.rglob("*") if p.is_file() and p.suffix in {".html", ".js", ".css"}]


def test_assets_served_under_app(client):
    for rel in [
        "", "config.js", "js/app.js", "js/api.js",
        "js/components/cqa-app.js", "js/components/cqa-conversations-list.js",
    ]:
        assert client.get("/app/" + rel).status_code == 200, rel


def test_index_references_are_relative(client):
    html = client.get("/app/").text
    refs = re.findall(r'(?:src|href)="([^"]+)"', html)
    assert refs
    for ref in refs:
        assert not ref.startswith(("/", "http:", "https:")), ref


def test_no_absolute_paths_in_sources():
    for path in frontend_files():
        text = path.read_text(encoding="utf-8")
        assert not re.search(r'["\'`]/(?:api|app|static)\b', text), path
        assert not re.search(r'from\s+["\']/', text), path
        assert not re.search(r'import\s*\(?\s*["\']/', text), path


def test_config_object_and_api_base():
    config_js = (FRONTEND / "config.js").read_text(encoding="utf-8")
    assert "window.CQA_CONFIG" in config_js and "apiBase" in config_js
    assert "CQA_CONFIG" in (FRONTEND / "js" / "api.js").read_text(encoding="utf-8")


def test_components_use_shadow_dom_and_no_comments():
    for name in ["cqa-app.js", "cqa-conversations-list.js"]:
        text = (FRONTEND / "js" / "components" / name).read_text(encoding="utf-8")
        assert "attachShadow" in text
        assert "customElements.define" in text
    for path in frontend_files():
        text = path.read_text(encoding="utf-8")
        assert not re.search(r"^\s*//", text, re.M), path
        assert "/*" not in text and "<!--" not in text, path


def test_api_base_resolves_to_backend_from_app_path(client):
    assert client.get("/app/../api/v1/datasets").status_code == 200


def test_new_pages_are_served_with_relative_references(client):
    for page in ["next.html", "demo.html", "embed-test.html", "gallery.html"]:
        response = client.get("/app/" + page)
        assert response.status_code == 200, page
        for ref in re.findall(r'(?:src|href)="([^"]+)"', response.text):
            assert not ref.startswith(("/", "http:", "https:", "//")), (page, ref)
    for rel in ["src/demo.js", "src/demo-steps.js", "src/embed-test.js", "styles/tokens.css", "src/fonts/OFL.txt"]:
        assert client.get("/app/" + rel).status_code == 200, rel
