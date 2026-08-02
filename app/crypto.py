"""At-rest encryption for secrets (Claude API key, B2 application key) stored in the settings table.

The key lives outside data/ so it never ends up in a database backup (local copy or
B2 upload) alongside the ciphertext it protects.
"""

import logging

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import String
from sqlalchemy.types import TypeDecorator

from .database import BASE_DIR

logger = logging.getLogger("raven.crypto")

KEY_PATH = BASE_DIR / ".raven.key"


def _load_or_create_key() -> bytes:
    if KEY_PATH.exists():
        return KEY_PATH.read_bytes()
    key = Fernet.generate_key()
    KEY_PATH.write_bytes(key)
    try:
        KEY_PATH.chmod(0o600)
    except (NotImplementedError, OSError):
        pass  # best-effort; not all platforms (e.g. Windows) honor POSIX modes
    return key


_fernet = Fernet(_load_or_create_key())


def encrypt(value: str) -> str:
    return _fernet.encrypt(value.encode()).decode()


def decrypt(token: str) -> str:
    try:
        return _fernet.decrypt(token.encode()).decode()
    except InvalidToken:
        # Value predates encryption support (or the key changed) — treat as plaintext
        # rather than breaking the app. It gets re-encrypted the next time it's saved.
        logger.warning("Stored secret was not encrypted with the current key; treating as legacy plaintext.")
        return token


def is_encrypted(value: str) -> bool:
    try:
        _fernet.decrypt(value.encode())
        return True
    except InvalidToken:
        return False


class EncryptedString(TypeDecorator):
    """String column that is transparently encrypted at rest and decrypted on read."""

    impl = String
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return encrypt(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return decrypt(value)
