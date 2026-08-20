import imaplib
from datetime import datetime, timedelta
from email import message_from_bytes
from email.header import decode_header
from email.utils import parseaddr

from fastapi import HTTPException

CONNECT_TIMEOUT = 20
MAX_RESULTS = 25
SNIPPET_LENGTH = 500


def _connect(host: str | None, port: int | None, username: str | None, password: str | None) -> imaplib.IMAP4_SSL:
    if not (host and username and password):
        raise HTTPException(400, "IMAP host, username, and password are all required.")
    try:
        conn = imaplib.IMAP4_SSL(host, port or 993, timeout=CONNECT_TIMEOUT)
    except (OSError, imaplib.IMAP4.error) as exc:
        raise HTTPException(400, f"Could not reach IMAP host '{host}': {exc}")
    try:
        conn.login(username, password)
    except imaplib.IMAP4.error as exc:
        conn.logout()
        raise HTTPException(400, f"IMAP login failed: {exc}")
    return conn


def _select(conn: imaplib.IMAP4_SSL, folder: str) -> None:
    status, _ = conn.select(folder or "INBOX", readonly=True)
    if status != "OK":
        conn.logout()
        raise HTTPException(400, f"Could not open IMAP folder '{folder}'.")


def test_connection(host: str | None, port: int | None, username: str | None, password: str | None, folder: str | None) -> None:
    conn = _connect(host, port, username, password)
    try:
        _select(conn, folder or "INBOX")
    finally:
        conn.logout()


def _decode(raw: str | None) -> str:
    if not raw:
        return ""
    parts = decode_header(raw)
    decoded = []
    for text, encoding in parts:
        if isinstance(text, bytes):
            decoded.append(text.decode(encoding or "utf-8", errors="replace"))
        else:
            decoded.append(text)
    return "".join(decoded)


def _extract_snippet(msg) -> str:
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in str(part.get("Content-Disposition", "")):
                charset = part.get_content_charset() or "utf-8"
                try:
                    body = part.get_payload(decode=True).decode(charset, errors="replace")
                except Exception:
                    continue
                break
    else:
        charset = msg.get_content_charset() or "utf-8"
        try:
            body = msg.get_payload(decode=True).decode(charset, errors="replace")
        except Exception:
            body = ""
    body = " ".join(body.split())
    return body[:SNIPPET_LENGTH]


def search_emails(
    host: str | None,
    port: int | None,
    username: str | None,
    password: str | None,
    folder: str | None,
    sender: str | None = None,
    subject_contains: str | None = None,
    since_days: int | None = None,
    limit: int = 10,
) -> list[dict]:
    conn = _connect(host, port, username, password)
    try:
        _select(conn, folder or "INBOX")

        criteria: list[str] = []
        if sender:
            criteria += ["FROM", f'"{sender}"']
        if subject_contains:
            criteria += ["SUBJECT", f'"{subject_contains}"']
        if since_days is not None:
            since_date = (datetime.now() - timedelta(days=since_days)).strftime("%d-%b-%Y")
            criteria += ["SINCE", since_date]
        if not criteria:
            criteria = ["ALL"]

        try:
            status, data = conn.search(None, *criteria)
        except imaplib.IMAP4.error as exc:
            raise HTTPException(400, f"IMAP search failed: {exc}")
        if status != "OK":
            raise HTTPException(400, "IMAP search failed.")

        ids = data[0].split()
        ids = ids[-max(1, min(limit, MAX_RESULTS)):]
        ids.reverse()  # most recent first

        results = []
        for msg_id in ids:
            status, msg_data = conn.fetch(msg_id, "(BODY.PEEK[])")
            if status != "OK" or not msg_data or not msg_data[0]:
                continue
            raw = msg_data[0][1]
            msg = message_from_bytes(raw)
            from_name, from_addr = parseaddr(_decode(msg.get("From")))
            results.append(
                {
                    "from": f"{from_name} <{from_addr}>".strip() if from_name else from_addr,
                    "subject": _decode(msg.get("Subject")),
                    "date": msg.get("Date", ""),
                    "snippet": _extract_snippet(msg),
                }
            )
        return results
    finally:
        conn.logout()
