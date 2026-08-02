import logging
from logging.handlers import RotatingFileHandler

from .database import DATA_DIR

LOG_PATH = DATA_DIR / "raven.log"


def configure_logging() -> None:
    logger = logging.getLogger("raven")
    if logger.handlers:
        return  # already configured (e.g. reloaded under --reload)
    logger.setLevel(logging.INFO)

    file_handler = RotatingFileHandler(LOG_PATH, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(file_handler)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    logger.addHandler(console_handler)
