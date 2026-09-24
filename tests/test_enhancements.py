import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server.main import app
from server.desktop_dist import ensure_desktop_exe

client = TestClient(app)

def test_remote_pair_endpoint():
    # 1. Create a remote session
    resp = client.post("/api/remote/create", json={"title": "测试放映", "page": 1, "total": 10})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    sid = data["session_id"]
    code = data["code"]

    # 2. Look up the session by 4-digit code
    pair_resp = client.get(f"/api/remote/pair/{code}")
    assert pair_resp.status_code == 200
    pair_data = pair_resp.json()
    assert pair_data["ok"] is True
    assert pair_data["session_id"] == sid
    assert pair_data["code"] == code
    assert pair_data["title"] == "测试放映"

    # 3. Check QR PNG generation endpoint
    qr_resp = client.get(f"/api/remote/{sid}/qr")
    assert qr_resp.status_code == 200
    assert qr_resp.headers["content-type"] == "image/png"
    assert qr_resp.content.startswith(b"\x89PNG")

    # 4. Invalid code returns 404
    inv_resp = client.get("/api/remote/pair/0000")
    assert inv_resp.status_code == 404

def test_desktop_version_and_download():
    # Check version endpoint
    ver_resp = client.get("/api/desktop/version")
    assert ver_resp.status_code == 200
    ver_data = ver_resp.json()
    assert ver_data["ok"] is True
    assert ver_data["version"] == "1.36.0"

    # Check download endpoint
    dl_resp = client.get("/api/desktop/download")
    assert dl_resp.status_code == 200
    assert dl_resp.content.startswith(b"MZ")
    assert len(dl_resp.content) > 300000

def test_csharp_client_architecture():
    cs_path = REPO_ROOT / "desktop" / "FLA_Client.cs"
    assert cs_path.exists()
    content = cs_path.read_text(encoding="utf-8")
    assert "class FloatingDockForm" in content
    assert "class ScreenOverlayForm" in content
    assert "class MainForm" in content
    assert "class CloudFileItem" in content
    assert "LaunchOfficePresentation" in content
    assert "InitCastingTab" in content
    assert "StartSeewoInterceptor" in content
    assert "FindPresentationApp" in content
