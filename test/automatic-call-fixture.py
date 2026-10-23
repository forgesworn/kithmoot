#!/usr/bin/env python3
"""Disposable independent-operator model, not a public provider.

Real coturn REST authentication and the existing Node issuer, behind a local
HTTPS facade. Secrets stay in this process, child environment and 0600 files.
Only aggregate synthetic assertions are exposed; no access or container logs.
"""
import http.client
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import ssl
import subprocess
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from shutil import rmtree

PORT = int(os.environ.get("E2E_AUTOMATIC_TURN_PORT", "7794"))
APP_PORT = int(os.environ.get("E2E_PORT", "5594"))
root = Path(tempfile.mkdtemp(prefix="kithmoot-automatic-turn-"))
name = f"kithmoot-automatic-turn-{os.getpid()}"
child = None
issuer_port = None
refusing = False
issued = set()
observed = {"requests": 0, "cookies": False, "authorisation": False,
            "referrer": False, "query": False, "body": False}


def docker(*args):
    return subprocess.run(["docker", *args], check=True, capture_output=True,
                          text=True).stdout.strip()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", f"https://localhost:{APP_PORT}")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/":
            return self.reply({"ready": True})
        if self.path == "/stats":
            return self.reply({**observed, "distinctLogins": len(issued)})
        if self.path.split("?", 1)[0] != "/turn":
            return self.reply({"error": "Not found"}, 404)
        observed["requests"] += 1
        for key, header in [("cookies", "Cookie"), ("authorisation", "Authorization"),
                            ("referrer", "Referer")]:
            observed[key] |= bool(self.headers.get(header))
        observed["query"] |= "?" in self.path
        observed["body"] |= int(self.headers.get("Content-Length", "0")) != 0
        if refusing:
            return self.reply({"error": "unavailable"}, 503)
        # Exercise server/turn-credentials.mjs, not a fabricated RTC response.
        connection = http.client.HTTPConnection("127.0.0.1", issuer_port, timeout=3)
        try:
            headers = {}
            if self.headers.get("Origin"):
                headers["Origin"] = self.headers["Origin"]
            connection.request("GET", "/turn", headers=headers)
            response = connection.getresponse()
            body = json.loads(response.read())
            if response.status == 200:
                issued.add(body["username"])
            return self.reply(body, response.status)
        finally:
            connection.close()

    def do_POST(self):
        global refusing
        if self.path not in ["/refuse", "/resume"]:
            return self.reply({"error": "Not found"}, 404)
        refusing = self.path == "/refuse"
        return self.reply({"refusing": refusing})


def stop(*_):
    raise SystemExit(0)


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
try:
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"),
                    "-days", "1", "-subj", "/CN=localhost"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chmod(root / "key.pem", 0o600)
    secret = secrets.token_hex(32)
    config = root / "turn.conf"
    config.write_text("\n".join([
        "listening-ip=0.0.0.0", "listening-port=3478", "tls-listening-port=5349",
        "realm=automatic.invalid", "fingerprint", "use-auth-secret",
        f"static-auth-secret={secret}", "no-udp", "no-tcp", "no-dtls",
        "no-tcp-relay", "no-multicast-peers", "no-cli", "allow-loopback-peers",
        "min-port=49180", "max-port=49211", "user-quota=12", "total-quota=36",
        "max-bps=1000000", "log-file=/dev/null", "no-stdout-log",
        "cert=/fixture/cert.pem", "pkey=/fixture/key.pem", "",
    ]))
    os.chmod(config, 0o600)
    docker("run", "--rm", "-d", "--name", name, "--log-driver", "none",
           "--user", "0:0", "-v", f"{root}:/fixture:ro", "-p",
           "127.0.0.1::5349/tcp", "coturn/coturn:4.17.2-r0", "-c", "/fixture/turn.conf")
    turn_port = int(docker("port", name, "5349/tcp").rsplit(":", 1)[1])
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", turn_port), timeout=0.1):
                break
        except OSError:
            time.sleep(0.05)
    else:
        raise RuntimeError("TURN fixture listener did not start")
    ready = root / "issuer-ready.json"
    child = subprocess.Popen(["node", "--input-type=module", "-e", r"""
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
// Build the real issuer with its one library import resolved to source.
// A full library tsc build is unnecessary for this bounded server fixture.
await build({ entryPoints: ['server/turn-credentials.mjs'], bundle: true,
  platform: 'node', format: 'esm', outfile: process.env.FIXTURE_BUNDLE,
  plugins: [{name: 'issuer-turn-source', setup(builder) {
    builder.onResolve({filter: /dist\/src\/turn\.js$/}, () => ({path: resolve('src/turn.ts')}));
  }}] });
const { createTurnServer, loadConfigFromEnv } = await import(pathToFileURL(process.env.FIXTURE_BUNDLE));
const server = createTurnServer(loadConfigFromEnv());
server.listen(0, '127.0.0.1', () => writeFileSync(process.env.FIXTURE_READY,
  JSON.stringify({port: server.address().port}), {mode: 0o600}));
"""], env={**os.environ, "TURN_SECRET": secret,
            "TURN_URLS": f"turns:127.0.0.1:{turn_port}?transport=tcp",
            "TURN_TTL_SECONDS": "3600", "ALLOWED_ORIGINS": f"https://localhost:{APP_PORT}",
            "RATE_LIMIT_BURST": "30", "FIXTURE_READY": str(ready),
            "FIXTURE_BUNDLE": str(root / "issuer.mjs")},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if ready.exists():
            issuer_port = json.loads(ready.read_text())["port"]
            break
        if child.poll() is not None:
            raise RuntimeError("Independent issuer fixture did not start")
        time.sleep(0.05)
    else:
        raise RuntimeError("Independent issuer readiness timed out")
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(root / "cert.pem"), str(root / "key.pem"))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()
finally:
    if child is not None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rmtree(root)
