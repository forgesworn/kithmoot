import concurrent.futures
import hashlib
import json
import re
import subprocess
from pathlib import Path

repository = "forgesworn/kithmoot"
index = f"repos/{repository}/releases/tags/apt"
records = json.loads(Path(__file__).with_name("assets.json").read_text())
assert len(records) == 42
assert len({item["name"] for item in records}) == len(records)
work = Path(".restore-apt-staging")
work.mkdir()

def listing():
    result = subprocess.check_output(["gh", "api", index], text=True, timeout=40)
    release = json.loads(result)
    assert not release["draft"] and release["tag_name"] == "apt"
    return {record["name"]: record for record in release["assets"]}

def verify_asset(remote, record):
    assert remote["state"] == "uploaded"
    for field in ("name", "size", "digest"):
        assert remote[field] == record[field], (record["name"], field)

before = listing()

def restore(record):
    name = record["name"]
    version = re.fullmatch(r"kithmoot_(0\.1\.\d+)_(amd64|arm64)\.deb", name)[1]
    assert 158 <= int(version.split(".")[-1]) <= 178
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", record["digest"])
    if name in before:
        verify_asset(before[name], record)
        return name
    path = work / name
    sources = [
        f"https://github.com/{repository}/releases/download/v{version}/{name}",
        f"https://kithmoot.app/apk/desktop/{version}/{name}",
    ]
    try:
        for url in sources:
            copied = subprocess.run(
                ["curl", "--fail", "--silent", "--show-error", "--location", "--retry", "2",
                 "--max-time", "150", "--output", str(path), url], timeout=475,
            )
            if copied.returncode != 0 or path.stat().st_size != record["size"]:
                continue
            with path.open("rb") as stream:
                digest = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
            if digest == record["digest"]:
                break
        else:
            raise RuntimeError(f"No published copy matches the old APT digest for {name}")
        subprocess.run(["gh", "release", "upload", "apt", str(path), "--repo", repository],
            timeout=220, check=True)
        print(f"Restored {name} with its original SHA-256", flush=True)
        return name
    finally:
        path.unlink(missing_ok=True)

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for restored in pool.map(restore, records):
        assert restored

after = listing()
for record in records:
    verify_asset(after[record["name"]], record)
for name, record in before.items():
    verify_asset(after[name], record)
work.rmdir()
print(f"Verified {len(records)} historical package links and {len(before)} existing APT assets")
