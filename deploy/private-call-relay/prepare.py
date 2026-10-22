#!/usr/bin/env python3
"""Prepare an authenticated, private coturn deployment; never print credentials."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets


def prepare(directory: Path, host: str, public_ip: str, local: bool = False, port: int = 3478,
            relay_min: int = 49180, relay_max: int = 49211, udp_only: bool = False):
    if directory.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError("Keep relay credentials outside the repository")
    if not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", host):
        raise ValueError("Use a hostname or IPv4 address without a scheme or port")
    address = ipaddress.IPv4Address(public_ip)
    if not local and not address.is_global:
        raise ValueError("The deployment needs a public IPv4 address")
    if not 1 <= relay_min <= relay_max <= 65535 or relay_max - relay_min > 1023:
        raise ValueError("Choose a relay range of at most 1024 valid ports")
    if not 1 <= port <= 65535 or relay_min <= port <= relay_max:
        raise ValueError("Choose a valid listening port outside the relay range")
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(directory, 0o700)
    users = [("you", secrets.token_urlsafe(32)), ("friend", secrets.token_urlsafe(32))]
    config = f"""listening-port={port}
listening-ip={"0.0.0.0" if local else public_ip}
realm={host}
server-name={host}
fingerprint
lt-cred-mech
min-port={relay_min}
max-port={relay_max}
user-quota=12
total-quota=24
max-bps=1000000
no-tcp-relay
no-multicast-peers
no-cli
no-tls
no-dtls
log-file=/dev/null
no-stdout-log
"""
    if udp_only:
        config += "no-tcp\n"
    if local:
        # Both test clients use TURN/TCP. Advertise the container's real
        # relay address so their allocations can reach each other inside it;
        # advertising the host's loopback would send packets to the wrong socket.
        config += "allow-loopback-peers\n"
    else:
        # Pin allocations on multi-interface Docker hosts too: advertising
        # a public address for a socket bound to a bridge breaks hairpin calls.
        config += f"relay-ip={public_ip}\nexternal-ip={public_ip}\n"
        # Peer targets, not callers: a caller on home Wi-Fi is still welcome.
        config += "no-loopback-peers\n"
        for network in ["0.0.0.0-0.255.255.255", "10.0.0.0-10.255.255.255", "100.64.0.0-100.127.255.255",
                        "127.0.0.0-127.255.255.255", "169.254.0.0-169.254.255.255", "172.16.0.0-172.31.255.255",
                        "192.168.0.0-192.168.255.255", "224.0.0.0-255.255.255.255", "::1", "fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
                        "fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]:
            config += f"denied-peer-ip={network}\n"
    config += "".join(f"user={name}:{password}\n" for name, password in users)
    write_private(directory / "turnserver.conf", config)
    for name, password in users:
        write_private(directory / f"{name}.json", json.dumps({
            "urls": [f"turn:{host}:{port}?transport=udp"] if udp_only else
                    [f"turn:{host}:{port}", f"turn:{host}:{port}?transport=tcp"],
            "username": name, "credential": password,
        }, indent=2) + "\n")
    write_private(directory / "compose.yaml", """services:
  relay:
    image: coturn/coturn:4.17.2-r0
    restart: unless-stopped
    network_mode: host
    # Read the root-owned 0600 configuration, then drop privileges.
    user: '0:0'
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
    command: ['-c', '/etc/coturn/turnserver.conf', '--proc-user=nobody', '--proc-group=nogroup']
    logging:
      driver: none
""")
    return users


def write_private(path: Path, value: str):
    with path.open("x", encoding="utf-8") as output:
        os.chmod(path, 0o600)
        output.write(value)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--public-ip", required=True)
    parser.add_argument("--port", type=int, default=3478, help="TURN listener; choose a free port when STUN already uses 3478")
    parser.add_argument("--relay-min", type=int, default=49180)
    parser.add_argument("--relay-max", type=int, default=49211)
    parser.add_argument("--udp-only", action="store_true", help="Use only UDP when the host's upstream firewall requires it")
    parser.add_argument("--output", required=True, type=Path, help="A new directory outside the repository")
    args = parser.parse_args()
    try:
        prepare(args.output, args.host, args.public_ip, port=args.port,
                relay_min=args.relay_min, relay_max=args.relay_max, udp_only=args.udp_only)
    except (ValueError, FileExistsError) as error:
        parser.exit(2, f"Cannot prepare relay: {error}\n")
    print("Prepared private relay configuration and separate you.json / friend.json login files.")
    print("Keep the generated directory private. Run docker compose up -d from it on your Linux server.")
