#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=3) as response:
        if response.status != 200:
            raise AssertionError(f"Expected HTTP 200 for {url}, got {response.status}")
        return response.read()


def main() -> int:
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "server.py"), "--port", str(port), "--no-browser"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 5
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                index = fetch(base + "/index.html")
                break
            except Exception as exc:  # server may still be starting
                last_error = exc
                time.sleep(0.1)
        else:
            raise AssertionError(f"Server did not become ready: {last_error}")

        assert b"Ricky Bitcoin Mining Control Center v7" in index
        assert b"aggregateBatch" in fetch(base + "/app.js")
        assert b"doubleSha256" in fetch(base + "/miner-worker.js")
        assert b"function sha256" in fetch(base + "/sha256.js")
        print("Local server static-file smoke test passed.")
        return 0
    finally:
        proc.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=3)
        if proc.poll() is None:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
