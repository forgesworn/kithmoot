#!/usr/bin/env python3
"""Disposable independent-operator model, not a public provider.

Real coturn or Spry REST authentication and the existing Node issuer, behind a local
HTTPS facade. Secrets stay in this process, child environment and 0600 files.
Only aggregate synthetic assertions are exposed; no access or container logs.
"""
import http.client
import hashlib
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from shutil import rmtree
from threading import Lock

PORT = int(os.environ.get("E2E_AUTOMATIC_TURN_PORT", "7794"))
APP_PORT = int(os.environ.get("E2E_PORT", "5594"))
root = Path(tempfile.mkdtemp(prefix="kithmoot-automatic-turn-"))
name = f"kithmoot-automatic-turn-{os.getpid()}"
child = None
turn_child = None
container_started = False
server = None
issuer_port = None
state_lock = Lock()
refusing = False
issued = set()
observed = {"requests": 0, "cookies": False, "authorisation": False,
            "referrer": False, "query": False, "body": False}
backend = os.environ.get("E2E_TURN_BACKEND", "coturn")
if backend not in ("coturn", "spry"):
    rmtree(root)
    raise ValueError("E2E_TURN_BACKEND must be coturn or spry")
observed["turnBackend"] = backend


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
            with state_lock:
                snapshot = {**observed, "distinctLogins": len(issued)}
            return self.reply(snapshot)
        if self.path.split("?", 1)[0] != "/turn":
            return self.reply({"error": "Not found"}, 404)
        with state_lock:
            observed["requests"] += 1
            for key, header in [("cookies", "Cookie"), ("authorisation", "Authorization"),
                                ("referrer", "Referer")]:
                observed[key] |= bool(self.headers.get(header))
            observed["query"] |= "?" in self.path
            observed["body"] |= int(self.headers.get("Content-Length", "0")) != 0
            refused = refusing
        if refused:
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
                with state_lock:
                    issued.add(body["username"])
            return self.reply(body, response.status)
        finally:
            connection.close()

    def do_POST(self):
        global refusing
        if self.path not in ["/refuse", "/resume"]:
            return self.reply({"error": "Not found"}, 404)
        with state_lock:
            refusing = self.path == "/refuse"
            snapshot = refusing
        return self.reply({"refusing": snapshot})


class FacadeServer(ThreadingHTTPServer):
    # A browser's idle pre-opened socket must not block other credential
    # requests, including while the idle socket has not completed TLS.
    daemon_threads = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        try:
            secured = self.tls_context.wrap_socket(connection, server_side=True,
                                                   do_handshake_on_connect=False)
            return secured, address
        except Exception:
            connection.close()
            raise

    def finish_request(self, request, client_address):
        request.do_handshake()
        request.settimeout(30)
        super().finish_request(request, client_address)

    def handle_error(self, *_):
        # Idle socket expiry/disconnect is expected in these synthetic runs.
        # Do not turn peer addresses or request failures into access logs.
        pass


def stop(*_):
    raise SystemExit(0)


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
try:
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"),
                    "-days", "1", "-subj", "/CN=localhost",
                    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chmod(root / "key.pem", 0o600)
    secret = secrets.token_hex(32)
    if backend == "coturn":
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
        container_started = True
        turn_port = int(docker("port", name, "5349/tcp").rsplit(":", 1)[1])
    else:
        # Explicit local executable: never download, publish or fall back to
        # another server when the selected implementation cannot start.
        binary = Path(os.environ.get("E2E_SPRY_TURN_BINARY", ""))
        if not binary.is_absolute() or not binary.is_file():
            raise ValueError("Spry requires an absolute E2E_SPRY_TURN_BINARY path")
        observed["turnBinarySha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            turn_port = listener.getsockname()[1]
        turn_child = subprocess.Popen([
            str(binary), "serve", "--listen", "127.0.0.1:0",
            "--realm", "automatic.invalid", "--allow-loopback-peers",
            "--tls-listen", f"127.0.0.1:{turn_port}",
            "--tls-cert", str(root / "cert.pem"), "--tls-key", str(root / "key.pem"),
            "--max-per-user", "12", "--max-allocations", "36",
            "--bytes-per-second", "1000000",
        ], env={**os.environ, "SPRY_TURN_SECRET": secret},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if turn_child is not None and turn_child.poll() is not None:
            raise RuntimeError("Selected Spry TLS fixture exited before readiness")
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
    server = FacadeServer(("127.0.0.1", PORT), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(root / "cert.pem"), str(root / "key.pem"))
    server.tls_context = context
    server.serve_forever()
finally:
    if server is not None:
        server.server_close()
    if child is not None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    if turn_child is not None:
        turn_child.terminate()
        try:
            turn_child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            turn_child.kill()
            turn_child.wait()
    if container_started:
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rmtree(root)
