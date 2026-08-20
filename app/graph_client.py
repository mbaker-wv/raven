"""Microsoft Graph mail access via OAuth2 device code flow (read-only, Mail.Read scope).

Uses plain HTTP calls to the Microsoft identity platform and Graph API, same style as
claude_client.py, rather than pulling in the msal SDK for two REST endpoints.
"""

import base64
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

from fastapi import HTTPException

from .net import SSL_CONTEXT

AUTHORITY = "https://login.microsoftonline.com/{tenant}"
DEVICE_CODE_PATH = "/oauth2/v2.0/devicecode"
TOKEN_PATH = "/oauth2/v2.0/token"
GRAPH_API_URL = "https://graph.microsoft.com/v1.0"
# openid/profile are always available on any app registration; Mail.Read/offline_access
# must be the permission actually added (and consented to) on the Azure app.
SCOPES = "openid profile offline_access Mail.Read"
FETCH_BATCH_SIZE = 50


def _post_form(url: str, data: dict, timeout: int = 30) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CONTEXT) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        # The device-code token endpoint returns HTTP 400 with a JSON body for expected
        # states like authorization_pending — parse it so callers can inspect "error"
        # rather than treating every non-2xx as fatal.
        body_text = exc.read().decode(errors="replace")
        try:
            return json.loads(body_text)
        except json.JSONDecodeError:
            raise HTTPException(502, f"Microsoft identity platform error ({exc.code}): {body_text}")
    except urllib.error.URLError as exc:
        raise HTTPException(502, f"Could not reach Microsoft identity platform: {getattr(exc, 'reason', exc)}")


def start_device_flow(client_id: str | None, tenant_id: str | None) -> dict:
    if not (client_id and tenant_id):
        raise HTTPException(400, "Client ID and Tenant ID are both required.")
    url = AUTHORITY.format(tenant=tenant_id) + DEVICE_CODE_PATH
    data = _post_form(url, {"client_id": client_id, "scope": SCOPES})
    if "device_code" not in data:
        raise HTTPException(400, data.get("error_description", "Could not start Microsoft sign-in."))
    return data


def poll_device_flow(client_id: str, tenant_id: str, device_code: str) -> dict | None:
    """Returns the token response once the user completes sign-in, None while still
    pending, or raises for a real failure (denied, expired, misconfigured app)."""
    url = AUTHORITY.format(tenant=tenant_id) + TOKEN_PATH
    data = _post_form(
        url,
        {
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "client_id": client_id,
            "device_code": device_code,
        },
    )
    if "access_token" in data:
        return data
    if data.get("error") in ("authorization_pending", "slow_down"):
        return None
    raise HTTPException(400, data.get("error_description", f"Sign-in failed: {data.get('error', 'unknown error')}"))


def refresh_access_token(client_id: str, tenant_id: str, refresh_token: str) -> dict:
    url = AUTHORITY.format(tenant=tenant_id) + TOKEN_PATH
    data = _post_form(
        url,
        {
            "grant_type": "refresh_token",
            "client_id": client_id,
            "refresh_token": refresh_token,
            "scope": SCOPES,
        },
    )
    if "access_token" not in data:
        raise HTTPException(400, data.get("error_description", "Could not refresh Microsoft 365 sign-in — reconnect in Admin."))
    return data


def decode_id_token_email(id_token: str | None) -> str | None:
    """Best-effort display of which account got connected. Not used for auth — the
    access_token is what actually calls Graph — so signature verification isn't needed."""
    if not id_token:
        return None
    try:
        payload_b64 = id_token.split(".")[1]
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        claims = json.loads(base64.urlsafe_b64decode(padded))
    except Exception:
        return None
    return claims.get("preferred_username") or claims.get("email") or claims.get("upn")


def _graph_get(access_token: str, path: str) -> dict:
    req = urllib.request.Request(f"{GRAPH_API_URL}{path}", headers={"Authorization": f"Bearer {access_token}"})
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CONTEXT) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        try:
            detail = json.loads(body_text).get("error", {}).get("message", body_text)
        except json.JSONDecodeError:
            detail = body_text
        raise HTTPException(502, f"Microsoft Graph error ({exc.code}): {detail}")
    except urllib.error.URLError as exc:
        raise HTTPException(502, f"Could not reach Microsoft Graph: {getattr(exc, 'reason', exc)}")


def search_messages(
    access_token: str,
    folder: str | None,
    sender: str | None = None,
    subject_contains: str | None = None,
    since_days: int | None = None,
    limit: int = 10,
) -> list[dict]:
    """Fetches the most recent FETCH_BATCH_SIZE messages from `folder` and filters
    client-side — simple and good enough for an agent's "recent context" lookups, not a
    full mailbox search. `folder` must be a well-known name (inbox, sentitems, ...) or a
    real folder id, not a display name."""
    top = min(max(limit, FETCH_BATCH_SIZE) if (sender or subject_contains or since_days) else limit, FETCH_BATCH_SIZE)
    query = urllib.parse.urlencode(
        {"$top": top, "$orderby": "receivedDateTime desc", "$select": "subject,from,receivedDateTime,bodyPreview"}
    )
    path = f"/me/mailFolders/{urllib.parse.quote(folder or 'inbox')}/messages?{query}"
    messages = _graph_get(access_token, path).get("value", [])

    since_cutoff = datetime.now().astimezone() - timedelta(days=since_days) if since_days is not None else None
    results = []
    for msg in messages:
        from_info = (msg.get("from") or {}).get("emailAddress") or {}
        from_name, from_addr = from_info.get("name", ""), from_info.get("address", "")
        if sender and sender.lower() not in f"{from_name} {from_addr}".lower():
            continue
        subject = msg.get("subject") or ""
        if subject_contains and subject_contains.lower() not in subject.lower():
            continue
        received = msg.get("receivedDateTime")
        if since_cutoff and received:
            try:
                if datetime.fromisoformat(received.replace("Z", "+00:00")) < since_cutoff:
                    continue
            except ValueError:
                pass
        results.append(
            {
                "from": f"{from_name} <{from_addr}>".strip() if from_name else from_addr,
                "subject": subject,
                "date": received or "",
                "snippet": (msg.get("bodyPreview") or "")[:500],
            }
        )
        if len(results) >= limit:
            break
    return results
