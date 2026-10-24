#!/usr/bin/env python3
"""Check whether leaf_only actually prevents this pin from forwarding.

An observation tool: successful packet delivery is evidence against relying
on the flag as a no-transit boundary. No application or public networking.
"""
import json
import os
from pathlib import Path
import select
import signal
import sys
import tempfile
import time
from mesh import Mesh, PIN, setup

signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
os.umask(0o077)
with tempfile.TemporaryDirectory(prefix="km-fips-leaf-") as directory:
    mesh = Mesh(str(Path(sys.argv[1]).resolve()), directory, 1472)
    try:
        hub = mesh.node("leaf-transit", leaf_only=True)
        left = mesh.node("left", hub)
        right = mesh.node("right", hub)
        reports_leaf_only = all("leaf_only: true" in (Path(directory) / name / "daemon.log").read_text()
                                for name in ["leaf-transit", "left", "right"])
        if not reports_leaf_only:
            raise RuntimeError("Daemons did not confirm loading leaf-only mode")
        flows = []
        for own, remote in [(left, right), (right, left)]:
            flow, _ = setup(own["path"], {
                "peer": remote["npub"], "local_port": 24000, "remote_port": 24000})
            mesh.sockets.append(flow)
            flows.append(flow)
        delivered = False
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            flows[0].send(b"synthetic-leaf-transit-probe")
            if select.select([flows[1]], [], [], 0.5)[0]:
                delivered = flows[1].recv(2048) == b"synthetic-leaf-transit-probe"
                if delivered:
                    break
        print(json.dumps({"pin": PIN, "allNodesConfiguredLeafOnly": True,
                          "daemonReportsAllLeafOnly": reports_leaf_only,
                          "topology": "left -- leaf-only transit -- right; loopback UDP only",
                          "transitDelivered": delivered,
                          "meaning": "Do not rely on leaf_only as an enforced no-transit boundary" if delivered
                          else "No delivery observed; this alone does not establish enforcement"}, indent=2))
    finally:
        mesh.close()
