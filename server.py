#!/usr/bin/env python3
"""Local web server for Ricky Bitcoin Mining Control Center v7."""
from __future__ import annotations

import argparse
import json
import os
import threading
import time
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = {"at": 0.0, "payload": None}
CACHE_SECONDS = 15


def fetch_json_or_text(url: str, timeout: float = 8.0):
    request = urllib.request.Request(url, headers={"User-Agent": "RickyMinerV7/1.1"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw.strip()


def network_payload() -> dict:
    now = time.time()
    if CACHE["payload"] and now - CACHE["at"] < CACHE_SECONDS:
        return CACHE["payload"]

    difficulty = None
    height = None
    tip_hash = None
    sources: list[str] = []

    try:
        data = fetch_json_or_text("https://mempool.space/api/v1/mining/hashrate/1m")
        if isinstance(data, dict):
            difficulty = data.get("currentDifficulty") or data.get("difficulty")
            sources.append("mempool.space")
    except Exception:
        pass

    try:
        height = int(fetch_json_or_text("https://mempool.space/api/blocks/tip/height"))
        tip_hash = str(fetch_json_or_text("https://mempool.space/api/blocks/tip/hash"))
        if "mempool.space" not in sources:
            sources.append("mempool.space")
    except Exception:
        pass

    if not difficulty:
        try:
            difficulty = float(fetch_json_or_text("https://blockchain.info/q/getdifficulty"))
            sources.append("blockchain.info")
        except Exception:
            pass

    if height is None:
        try:
            height = int(fetch_json_or_text("https://blockchain.info/q/getblockcount"))
            if "blockchain.info" not in sources:
                sources.append("blockchain.info")
        except Exception:
            pass

    network_hashrate = float(difficulty) * (2**32) / 600 if difficulty else None
    payload = {
        "difficulty": float(difficulty) if difficulty else None,
        "networkHashrate": network_hashrate,
        "height": height,
        "tipHash": tip_hash,
        "sources": sources,
        "fetchedAt": int(now * 1000),
    }
    CACHE.update(at=now, payload=payload)
    return payload


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/network":
            payload = json.dumps(network_payload()).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    os.chdir(ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/?version=v7"
    print("Ricky Bitcoin Mining Control Center v7")
    print(f"Open: {url}")
    print("Press Control-C to stop the local server.")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping v7 server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
