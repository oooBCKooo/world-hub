"""Hostile attempts run only inside the reviewed real Docker Python image."""
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys

config = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))


def cannot_read(path):
    try:
        Path(path).read_bytes()
        return False
    except OSError:
        return True


def cannot_write(path):
    try:
        Path(path).write_text("unauthorized", encoding="utf-8")
        return False
    except OSError:
        return True


def cannot_connect(host, port):
    try:
        connection = socket.create_connection((host, port), timeout=1)
        connection.close()
        return False
    except OSError:
        return True


try:
    subprocess.run([sys.executable, "-c", "print('forbidden child')"], check=True, timeout=2, capture_output=True)
    child_denied = False
except PermissionError:
    child_denied = True

controls = Path("/proc/self/status").read_text()
checks = {
    "nonRoot": os.getuid() > 0,
    "hostPrivateDenied": all(cannot_read(path) for path in config["settings"]["hostPrivatePaths"]),
    "otherInstanceDenied": all(cannot_read(path) for path in config["settings"]["otherInstancePaths"]),
    "sourceWriteDenied": cannot_write("/source/bridge-kit.mjs"),
    "configWriteDenied": cannot_write("/configuration.json"),
    "rootWriteDenied": cannot_write("/unauthorized-root-file"),
    "dockerSocketDenied": cannot_read("/var/run/docker.sock"),
    "hostNetworkDenied": cannot_connect("127.0.0.1", config["settings"]["hostPort"]),
    "externalNetworkDenied": cannot_connect("1.1.1.1", 443),
    "subprocessDenied": child_denied,
    "noNewPrivileges": "NoNewPrivs:\t1" in controls,
    "seccompEnforced": "Seccomp:\t2" in controls,
}
Path("/state/allowed-output.json").write_text(json.dumps(checks))
runpy.run_path(str(Path(__file__).with_name("business.py")), run_name="__main__")
