from .database import BASE_DIR

VERSION_PATH = BASE_DIR / "VERSION"


def get_version() -> str:
    if VERSION_PATH.exists():
        return VERSION_PATH.read_text().strip()
    return "0.0.0"
