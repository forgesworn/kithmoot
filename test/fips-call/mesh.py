#!/usr/bin/env python3
"""Local synthetic-call fixture. No TUN, public discovery or production services.

stdin/stdout: bounded JSON lines. The bridge copies opaque ICE/DTLS/SRTP
datagrams; it has no room, signalling or media encryption keys.
"""
import array
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

PIN = "4cab546c6117ce5dfd28b86a4ddcd4cd943978f5"
GOOD_PROBE = b"kithmoot-fixture-expected-peer"
BAD_PROBE = b"kithmoot-fixture-wrong-peer"


def setup(path, params):
    received_fds = []
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as control:
            control.settimeout(5)
            control.connect(str(path))
            control.sendall(json.dumps({"command": "connect", "params": params}).encode() + b"\n")
            data = b""
            while b"\n" not in data:
                chunk, ancillary, flags, _ = control.recvmsg(
                    8192, socket.CMSG_SPACE(16), getattr(socket, "MSG_CMSG_CLOEXEC", 0))
                for level, kind, value in ancillary:
                    if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                        fds = array.array("i")
                        fds.frombytes(value[:len(value) - len(value) % fds.itemsize])
                        received_fds.extend(fds)
                if flags & socket.MSG_CTRUNC or not chunk or len(data) + len(chunk) > 8192:
                    raise RuntimeError("Invalid native API reply")
                data += chunk
            reply = json.loads(data)
            if reply["status"] != "ok" or len(received_fds) != 1:
                raise RuntimeError("Native flow refused")
            fd = received_fds.pop()
            os.set_inheritable(fd, False)
            return socket.socket(fileno=fd), reply["data"]["max_payload"]
    finally:
        for fd in received_fds:
            os.close(fd)


class Mesh:
    def __init__(self, binary, directory, mtu):
        self.binary, self.directory = binary, Path(directory)
        self.mtu = mtu
        self.nodes, self.bridges, self.sockets = [], [], []
        self.selector = selectors.DefaultSelector()
        self.running = True
        self.worker_error = None
        self.probes = {"expected": 0, "wrong": 0}

    def node(self, name, hub=None, leaf_only=None):
        directory = self.directory / name
        directory.mkdir(mode=0o700)
        # Reserve a loopback UDP endpoint. No root/network-interface changes.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        config = {
            "node": {"identity": {"persistent": True},
                     "leaf_only": hub is not None if leaf_only is None else leaf_only,
                     "control": {"enabled": False},
                     "native_api": {"enabled": True, "socket_path": str(directory / "api.sock")}},
            "tun": {"enabled": False}, "dns": {"enabled": False},
            "transports": {"udp": {"bind_addr": f"127.0.0.1:{port}", "mtu": self.mtu}},
            "peers": [] if hub is None else [{"npub": hub["npub"], "addresses": [
                {"transport": "udp", "addr": f"127.0.0.1:{hub['port']}"}]}],
        }
        config_path = directory / "fips.yaml"
        config_path.write_text(json.dumps(config))
        log = open(directory / "daemon.log", "wb")
        process = subprocess.Popen([self.binary, "--config", str(config_path)],
                                   cwd=directory, stdout=log, stderr=subprocess.STDOUT)
        node = {"process": process, "log": log, "path": directory / "api.sock", "port": port}
        self.nodes.append(node)
        deadline = time.monotonic() + 20
        while not node["path"].exists() or not (directory / "fips.pub").exists():
            if process.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError(f"Fixture node {name} did not start: " + (directory / "daemon.log").read_text()[-3000:])
            time.sleep(0.05)
        node["npub"] = (directory / "fips.pub").read_text().strip()
        return node

    def pair(self, ends):
        number = len(self.bridges)
        port = 20000 + number
        bridges = []
        for index, node_index in enumerate(ends):
            own, remote = self.nodes[node_index + 1], self.nodes[ends[1-index] + 1]
            flow, maximum = setup(own["path"], {"peer": remote["npub"], "local_port": port, "remote_port": port})
            self.sockets.append(flow)
            udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.sockets.append(udp)
            udp.bind(("127.0.0.1", 0))
            bridge = {"flow": flow, "udp": udp, "maximum": maximum, "target": None,
                      "sent": 0, "received": 0, "oversize": 0, "untrusted": 0, "blocked": 0}
            for kind in ["flow", "udp"]:
                bridge[kind].setblocking(False)
                self.selector.register(bridge[kind], selectors.EVENT_READ, (bridge, kind))
            bridges.append(bridge)
        self.bridges.append(bridges)
        return [b["udp"].getsockname()[1] for b in bridges]

    def pump(self):
        try:
            while self.running:
                for key, _ in self.selector.select(0.1):
                    bridge, kind = key.data
                    if kind == "udp":
                        data, source = bridge["udp"].recvfrom(65536)
                        if source != bridge["target"]:
                            bridge["untrusted"] += 1
                            continue
                        if len(data) > bridge["maximum"]:
                            bridge["oversize"] += 1
                            continue
                        try:
                            bridge["flow"].send(data)
                            bridge["sent"] += 1
                        except BlockingIOError:
                            bridge["blocked"] += 1
                    else:
                        data, _, flags, _ = bridge["flow"].recvmsg(bridge["maximum"])
                        if flags & socket.MSG_TRUNC:
                            raise RuntimeError("Truncated native datagram")
                        if data in (GOOD_PROBE, BAD_PROBE):
                            self.probes["expected" if data == GOOD_PROBE else "wrong"] += 1
                            continue
                        if bridge["target"] is not None:
                            bridge["udp"].sendto(data, bridge["target"])
                            bridge["received"] += 1
        except Exception as error:
            self.worker_error = str(error)

    def command(self, request):
        if self.worker_error:
            raise RuntimeError(self.worker_error)
        if request["op"] == "pair":
            return self.pair(request["ends"])
        if request["op"] == "targets":
            for bridge, target in zip(self.bridges[request["pair"]], request["targets"], strict=True):
                bridge["target"] = tuple(target)
            return True
        if request["op"] == "stats":
            return [[{key: b[key] for key in ["sent", "received", "oversize", "untrusted", "blocked", "maximum"]}
                     for b in pair] for pair in self.bridges]
        if request["op"] == "identity-probe":
            # The first flow at leaf 0 is bound to leaf 1's key and port.
            # Send to that held port from leaf 2 as well as from leaf 1.
            wrong, _ = setup(self.nodes[3]["path"], {
                "peer": self.nodes[1]["npub"], "local_port": 30000, "remote_port": 20000})
            self.sockets.append(wrong)
            wrong.send(BAD_PROBE)
            self.bridges[0][1]["flow"].send(GOOD_PROBE)
            time.sleep(2)
            return dict(self.probes)
        if request["op"] == "cut":
            self.nodes[0]["process"].terminate()
            self.nodes[0]["process"].wait(timeout=10)
            return True
        raise ValueError("Unknown fixture operation")

    def close(self):
        self.running = False
        if hasattr(self, "thread"):
            self.thread.join(timeout=2)
        self.selector.close()
        for sock in self.sockets:
            sock.close()
        for node in reversed(self.nodes):
            process = node["process"]
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            node["log"].close()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    os.umask(0o077)
    mtu = int(sys.argv[2]) if len(sys.argv) > 2 else 1280
    if mtu not in (1280, 1472):
        raise ValueError("Fixture MTU must be 1280 or 1472")
    binary_path = Path(sys.argv[1]).resolve()
    source = binary_path.parent.parent.parent
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    if revision != PIN:
        raise RuntimeError("FIPS source revision differs from reviewed pin")
    subprocess.run(["git", "diff", "--quiet", "HEAD"], cwd=source, check=True)
    with tempfile.TemporaryDirectory(prefix="km-fips-") as directory:
        mesh = Mesh(str(binary_path), directory, mtu)
        try:
            hub = mesh.node("transit")
            for i in range(4):
                mesh.node(f"leaf-{i}", hub)
            mesh.thread = threading.Thread(target=mesh.pump, daemon=True)
            mesh.thread.start()
            print(json.dumps({"ready": True, "pin": PIN,
                              "binarySha256": hashlib.sha256(binary_path.read_bytes()).hexdigest(),
                              "leafNodes": 4, "transitNodes": 1, "transportMtu": mtu}), flush=True)
            for line in sys.stdin:
                if len(line) > 8192:
                    raise ValueError("Fixture request too large")
                print(json.dumps(mesh.command(json.loads(line))), flush=True)
        finally:
            mesh.close()
