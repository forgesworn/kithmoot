#!/usr/bin/env python3
"""Two isolated, loopback-published TURN/TLS fixtures; no production credentials.

TLS uses a temporary self-signed certificate. Chromium's test-only certificate
exception is required; this does not qualify public PKI or Internet firewalls.
The servers share a Docker network for relay-to-relay UDP, not browser UDP.
"""
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from shutil import rmtree

IMAGE = "coturn/coturn:4.17.2-r0"
API_PORT = int(os.environ.get("E2E_INDEPENDENT_TURN_PORT", "7793"))
root = Path(tempfile.mkdtemp(prefix="kithmoot-independent-turn-"))
network = f"kithmoot-independent-turn-{os.getpid()}"
containers = {}
accounts = {}


def docker(*args):
    return subprocess.run(["docker", *args], check=True, capture_output=True, text=True).stdout.strip()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/":
            return self.reply({"ready": True, "transport": "tls", "instances": 2})
        if self.path in accounts:
            return self.reply(accounts[self.path])
        self.reply({"error": "Not found"}, 404)

    def do_POST(self):
        if self.path == "/stop/alpha":
            docker("stop", "--time", "0", containers["alpha"])
            return self.reply({"stopped": "alpha"})
        self.reply({"error": "Not found"}, 404)


def stop(*_):
    raise SystemExit(0)


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
try:
    # No public listeners, Docker logs, daemon credentials or named volumes.
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"),
                    "-days", "1", "-subj", "/CN=localhost"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chmod(root / "key.pem", 0o600)
    docker("network", "create", network)
    for instance in ["alpha", "beta"]:
        name = f"{network}-{instance}"
        containers[instance] = name
        users = [(f"participant-{i}", secrets.token_urlsafe(32)) for i in range(3)]
        config = "\n".join([
            "listening-ip=0.0.0.0", "listening-port=3478", "tls-listening-port=5349",
            f"realm={instance}.invalid", "fingerprint", "lt-cred-mech",
            "no-udp", "no-tcp", "no-dtls", "no-tcp-relay", "no-multicast-peers",
            "no-cli", "allow-loopback-peers", "min-port=49180", "max-port=49211",
            "user-quota=12", "total-quota=36", "max-bps=1000000",
            "log-file=/dev/null", "no-stdout-log",
            "cert=/fixture/cert.pem", "pkey=/fixture/key.pem",
            *[f"user={user}:{password}" for user, password in users], "",
        ])
        path = root / f"{instance}.conf"
        path.write_text(config)
        os.chmod(path, 0o600)
        docker("run", "--rm", "-d", "--name", name, "--network", network,
               "--log-driver", "none", "--user", "0:0", "-v", f"{root}:/fixture:ro",
               "-p", "127.0.0.1::5349/tcp", IMAGE, "-c", f"/fixture/{instance}.conf")
        port = int(docker("port", name, "5349/tcp").rsplit(":", 1)[1])
        # TLS listener readiness, without printing the generated credentials.
        for attempt in range(100):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    break
            except OSError:
                import time
                time.sleep(0.05)
        else:
            raise RuntimeError("TURN fixture listener did not start")
        for i, (user, password) in enumerate(users):
            accounts[f"/{instance}/{i}"] = {
                "urls": [f"turns:127.0.0.1:{port}?transport=tcp"],
                "username": user, "credential": password,
            }
    HTTPServer(("127.0.0.1", API_PORT), Handler).serve_forever()
finally:
    for name in containers.values():
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["docker", "network", "rm", network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rmtree(root)
