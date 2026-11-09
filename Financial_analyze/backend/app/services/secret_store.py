"""Local secret storage — macOS Keychain via the built-in `security` CLI.

Secrets never touch the database, .env, or git. Writes go through
`security -i` on stdin so the secret is not visible in the process list.
Tests swap the store with `use_store(MemoryStore())`.
"""
from __future__ import annotations

import re
import subprocess

SERVICE_PREFIX = "helix-financial-analyze"
# `security -i` tokenizes its stdin like a shell; restrict secrets to a safe
# alphabet instead of trying to quote arbitrary input.
_SAFE = re.compile(r"^[A-Za-z0-9._@-]{1,256}$")


class SecretStoreError(RuntimeError):
    pass


class KeychainStore:
    def _service(self, name: str) -> str:
        return f"{SERVICE_PREFIX}.{name}"

    def set(self, name: str, account: str, secret: str) -> None:
        if not _SAFE.match(secret) or not _SAFE.match(account):
            raise SecretStoreError("secret or account contains unsupported characters")
        cmd = f"add-generic-password -U -s {self._service(name)} -a {account} -w {secret}\n"
        proc = subprocess.run(["security", "-i"], input=cmd, text=True,
                              capture_output=True, timeout=15)
        if proc.returncode != 0 or "error" in (proc.stderr or "").lower():
            raise SecretStoreError(f"keychain write failed: {(proc.stderr or '').strip()[:200]}")

    def get(self, name: str, account: str) -> str | None:
        proc = subprocess.run(
            ["security", "find-generic-password", "-s", self._service(name), "-a", account, "-w"],
            text=True, capture_output=True, timeout=15)
        if proc.returncode != 0:
            return None
        return proc.stdout.rstrip("\n") or None

    def delete(self, name: str, account: str) -> None:
        subprocess.run(
            ["security", "delete-generic-password", "-s", self._service(name), "-a", account],
            text=True, capture_output=True, timeout=15)


class MemoryStore:
    """In-process store for tests."""

    def __init__(self):
        self.items: dict[tuple[str, str], str] = {}

    def set(self, name, account, secret):
        if not _SAFE.match(secret) or not _SAFE.match(account):
            raise SecretStoreError("secret or account contains unsupported characters")
        self.items[(name, account)] = secret

    def get(self, name, account):
        return self.items.get((name, account))

    def delete(self, name, account):
        self.items.pop((name, account), None)


_store = KeychainStore()


def get_store():
    return _store


def use_store(store) -> None:
    global _store
    _store = store
