#!/usr/bin/env python3
"""Launch one allowlisted personal Kiro MCP server without copying secrets.

The owned profile invokes this proxy. It re-reads the user's global mcp.json,
verifies the non-secret executable definition against the parent-recorded digest,
then execs the configured stdio server with its configured environment.
"""

import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

MAX_CONFIG_BYTES = 256 * 1024
ENVIRONMENT_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
EXECUTION_ENVIRONMENT_KEYS = {
    "PATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "PYTHONSTARTUP",
    "NODE_OPTIONS",
    "NODE_PATH",
    "RUBYOPT",
    "PERL5OPT",
    "PERL5LIB",
    "BASH_ENV",
    "ENV",
    "GCONV_PATH",
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "CLASSPATH",
}
SAFE_INHERITED_ENVIRONMENT_KEYS = {
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
}
SERVER_KEYS = {"command", "args", "env", "disabled", "autoApprove"}


def fail(message: str) -> "None":
    print(f"pi-herdr-agents Kiro MCP proxy: {message}", file=sys.stderr)
    raise SystemExit(2)


def string_list(value, label: str):
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        fail(f"{label} must be a list of strings")
    return list(value)


def normalize(name: str, value):
    if not isinstance(value, dict):
        fail(f'server "{name}" must be an object')
    unknown = sorted(set(value) - SERVER_KEYS)
    if unknown:
        fail(f'server "{name}" has unsupported fields: {", ".join(unknown)}')
    disabled = value.get("disabled", False)
    if not isinstance(disabled, bool):
        fail(f'server "{name}" disabled must be boolean')
    if disabled:
        fail(f'server "{name}" is disabled')
    command = value.get("command")
    if not isinstance(command, str) or not command.strip() or "\0" in command:
        fail(f'server "{name}" is not a configured stdio command')
    args = string_list(value.get("args", []), f"{name}.args")
    if any("\0" in argument for argument in args):
        fail(f"{name}.args cannot contain NUL characters")
    env = value.get("env", {})
    if not isinstance(env, dict) or any(
        not isinstance(key, str)
        or not ENVIRONMENT_KEY.fullmatch(key)
        or not isinstance(item, str)
        or "\0" in item
        for key, item in env.items()
    ):
        fail(f"{name}.env must use portable names and NUL-free string values")
    execution_keys = [
        key
        for key in env
        if key in EXECUTION_ENVIRONMENT_KEYS
        or key.startswith("LD_")
        or key.startswith("DYLD_")
        or key.startswith("PI_")
        or key.startswith("HERDR_")
    ]
    if execution_keys:
        fail(
            f"{name}.env cannot override process-loader, executable-search, "
            f"or managed-run settings: {', '.join(execution_keys)}"
        )
    if "autoApprove" in value:
        string_list(value["autoApprove"], f"{name}.autoApprove")
    return {"command": command, "args": args, "envKeys": sorted(env)}, env


def read_regular_json(path: Path):
    try:
        before = path.lstat()
    except OSError as error:
        fail(f"cannot inspect {path}: {error}")
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        fail(f"configuration must be a regular file: {path}")
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino
        ):
            fail(f"configuration changed while it was opened: {path}")
        if opened.st_size > MAX_CONFIG_BYTES:
            fail(f"configuration exceeds {MAX_CONFIG_BYTES} bytes: {path}")
        with os.fdopen(descriptor, encoding="utf-8") as stream:
            descriptor = None
            return json.load(stream)
    except (OSError, ValueError) as error:
        fail(f"cannot read {path}: {error}")
    finally:
        if descriptor is not None:
            os.close(descriptor)


def main():
    if len(sys.argv) != 3:
        fail("usage: kiro-personal-mcp.py <owned-selection.json> <server-name>")
    owned_path = Path(os.path.abspath(sys.argv[1]))
    name = sys.argv[2]
    owned = read_regular_json(owned_path)
    if not isinstance(owned, dict) or owned.get("version") != 1:
        fail("owned selection is malformed")
    source = owned.get("sourceFile")
    records = owned.get("servers")
    if (
        not isinstance(source, str)
        or not Path(source).is_absolute()
        or not isinstance(records, list)
    ):
        fail("owned selection is malformed")
    record = next(
        (
            item
            for item in records
            if isinstance(item, dict) and item.get("name") == name
        ),
        None,
    )
    if not record or not isinstance(record.get("definitionSha256"), str):
        fail(f'server "{name}" is not in the owned selection')
    personal = read_regular_json(Path(source))
    configured = personal.get("mcpServers") if isinstance(personal, dict) else None
    if not isinstance(configured, dict) or name not in configured:
        fail(f'server "{name}" is no longer configured')
    normalized, server_env = normalize(name, configured[name])
    try:
        payload = json.dumps(
            normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
    except UnicodeEncodeError:
        fail(f'server "{name}" contains invalid Unicode')
    actual = hashlib.sha256(payload).hexdigest()
    if actual != record["definitionSha256"]:
        fail(f'server "{name}" changed after this run was prepared')
    environment = {
        key: value
        for key, value in os.environ.items()
        if key in SAFE_INHERITED_ENVIRONMENT_KEYS
    }
    environment.update(server_env)
    command = normalized["command"]
    argv = [command, *normalized["args"]]
    try:
        os.execvpe(command, argv, environment)
    except OSError as error:
        fail(f'cannot execute server "{name}": {error}')


if __name__ == "__main__":
    main()
