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

def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])

def fetch(url):
    with urllib.request.urlopen(url, timeout=3) as response:
        if response.status != 200:
            raise AssertionError(f"Expected HTTP 200 for {url}, got {response.status}")
        return response.read()

def main():
    port = free_port()
    proc = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--port", str(port), "--no-browser"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 5
        last_error = None
        while time.monotonic() < deadline:
            try:
                index = fetch(base + "/index.html")
                break
            except Exception as exc:
                last_error = exc
                time.sleep(0.1)
        else:
            raise AssertionError(f"Server did not become ready: {last_error}")
        app = fetch(base + "/app.js")
        app_render = fetch(base + "/app-render.js")
        app_runtime = fetch(base + "/app-runtime.js")
        worker = fetch(base + "/miner-worker.js")
        records = fetch(base + "/record-utils.js")
        assert b"Ricky Bitcoin Mining Control Center v7" in index
        assert b"record-utils.js" in index
        assert b"aggregateBatch" in app
        assert b"currentBlockHashes" in app
        assert b"not-submitted-local-only" in app
        assert b"renderCurrentBlock" in app_render
        assert b"loadNetwork" in app_runtime
        assert b"recordCandidates" in worker
        assert b"doubleSha256" in worker
        assert b"createRecord" in records
        assert b"reconcileBlockScope" in records
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
