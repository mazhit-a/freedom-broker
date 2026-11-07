import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"
PAGES = ["index.html", "demo.html", "embed-test.html", "gallery.html"]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CQA_DB_PATH", str(tmp_path / "t.db"))
    config.get_settings.cache_clear()
    from backend.app.main import app

    with TestClient(app) as c:
        yield c
    config.get_settings.cache_clear()


def frontend_files():
    return [
        p
        for p in FRONTEND.rglob("*")
        if p.is_file() and p.suffix in {".html", ".js", ".mjs", ".css"} and "node_modules" not in p.parts
    ]


def runtime_files():
    return [p for p in frontend_files() if "tests" not in p.relative_to(FRONTEND).parts]


def test_old_tree_is_gone_and_new_entry_exists():
    assert not (FRONTEND / "js").exists()
    assert not (FRONTEND / "next.html").exists()
    for rel in ["index.html", "config.js", "src/index.js", "src/api.js", "src/components/cqa-app.js"]:
        assert (FRONTEND / rel).is_file(), rel


def test_assets_served_under_app(client):
    for rel in [
        "", "index.html", "config.js", "src/index.js", "src/api.js", "src/api.mock.js",
        "src/components/cqa-app.js", "styles/tokens.css", "src/fonts/fonts.css", "src/fonts/OFL.txt",
    ]:
        assert client.get("/app/" + rel).status_code == 200, rel


def test_index_is_the_new_shell(client):
    html = client.get("/app/").text
    assert "<cqa-app>" in html
    assert 'src="config.js"' in html
    assert 'type="module" src="src/index.js"' in html
    assert "js/app.js" not in html


def test_served_pages_have_relative_references(client):
    for page in PAGES:
        response = client.get("/app/" + page)
        assert response.status_code == 200, page
        refs = re.findall(r'(?:src|href)="([^"]+)"', response.text)
        assert refs, page
        for ref in refs:
            if ref.startswith("data:"):
                continue
            assert not ref.startswith(("/", "http:", "https:", "//")), (page, ref)


def test_static_content_types(client):
    assert client.get("/app/").headers["content-type"].startswith("text/html")
    assert client.get("/app/demo.html").headers["content-type"].startswith("text/html")
    assert "javascript" in client.get("/app/src/index.js").headers["content-type"]
    assert client.get("/app/styles/tokens.css").headers["content-type"].startswith("text/css")
    fonts = sorted((FRONTEND / "src" / "fonts").glob("*.woff2"))
    assert fonts
    for font in fonts:
        response = client.get("/app/src/fonts/" + font.name)
        assert response.status_code == 200, font.name
        assert "font/woff2" in response.headers["content-type"] or "woff2" in response.headers["content-type"]


def test_no_absolute_paths_in_sources():
    for path in runtime_files():
        text = path.read_text(encoding="utf-8")
        assert not re.search(r'["\'`]/(?:api|app|static)\b', text), path
        assert not re.search(r'from\s+["\']/', text), path
        assert not re.search(r'import\s*\(?\s*["\']/', text), path
        assert not re.search(r"https?://", text), path


def test_config_object_and_api_base():
    config_js = (FRONTEND / "config.js").read_text(encoding="utf-8")
    assert "window.CQA_CONFIG" in config_js and "apiBase" in config_js
    assert "CQA_CONFIG" in (FRONTEND / "src" / "api.js").read_text(encoding="utf-8")


def test_components_use_shadow_dom():
    base = (FRONTEND / "src" / "base-element.js").read_text(encoding="utf-8")
    assert "attachShadow" in base
    assert len(list((FRONTEND / "src" / "components").glob("cqa-*.js"))) >= 10
    assert "customElements.define" in (FRONTEND / "src" / "register.js").read_text(encoding="utf-8")


def test_no_comments_in_frontend_sources():
    for path in frontend_files():
        if path.name == "static.test.js":
            continue
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"https?://", "", text)
        assert not re.search(r"^\s*//", text, re.M), path
        assert "<!--" not in text, path
        if path.suffix in {".css", ".html"}:
            assert "/*" not in text, path


def test_no_leftover_imports_of_removed_files():
    for path in frontend_files():
        if path.name in {"static.test.js"}:
            continue
        text = path.read_text(encoding="utf-8")
        assert "js/components" not in text, path
        assert "js/app.js" not in text, path
        assert "next.html" not in text, path


def test_fonts_are_local():
    fonts_dir = FRONTEND / "src" / "fonts"
    assert list(fonts_dir.glob("*.woff2"))
    assert (fonts_dir / "OFL.txt").is_file()
    css = (fonts_dir / "fonts.css").read_text(encoding="utf-8")
    for url in re.findall(r"url\(([^)]+)\)", css):
        url = url.strip("\"'")
        assert not url.startswith(("/", "http:", "https:")), url


def test_api_base_resolves_to_backend_from_app_path(client):
    assert client.get("/app/../api/v1/datasets").status_code == 200
