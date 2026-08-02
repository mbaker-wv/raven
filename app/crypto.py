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


def decrypt(token: str) -> str | None:
    try:
        return _fernet.decrypt(token.encode()).decode()
    except InvalidToken:
        if token.startswith("gAAAAA"):
            # It's a Fernet token, just not one this machine's key can open — most likely a
            # database restored from another machine without also copying .raven.key over.
            # Return None (unset) rather than the raw ciphertext, which would otherwise get
            # used as if it were a real API key and fail in a much more confusing way.
            logger.warning(
                "Stored secret is encrypted but not with this machine's key (restored without "
                "matching .raven.key?) — treating as unset. Re-enter it in Admin."
            )
            return None
        # Doesn't look like a Fernet token at all — predates encryption support, treat as
        # plaintext. It gets re-encrypted the next time it's saved.
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
