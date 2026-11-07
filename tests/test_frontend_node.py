import shutil
import subprocess
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_frontend_node_unit_tests():
    result = subprocess.run(
        ["node", "--test", "tests/*.test.js"],
        cwd=FRONTEND,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
