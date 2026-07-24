from pathlib import Path

from fastapi import HTTPException


def get_bucket(key_id: str, application_key: str, bucket_name: str):
    from b2sdk.v2 import B2Api, InMemoryAccountInfo

    info = InMemoryAccountInfo()
    b2_api = B2Api(info)
    try:
        b2_api.authorize_account("production", key_id, application_key)
    except Exception as exc:
        raise HTTPException(400, f"B2 authorization failed: {exc}")
    try:
        return b2_api.get_bucket_by_name(bucket_name)
    except Exception as exc:
        raise HTTPException(400, f"Could not find B2 bucket '{bucket_name}': {exc}")


def upload_file(bucket, local_path: Path, remote_name: str) -> None:
    try:
        bucket.upload_local_file(local_file=str(local_path), file_name=remote_name)
    except Exception as exc:
        raise HTTPException(502, f"Upload to B2 failed: {exc}")


def test_connection(key_id: str | None, application_key: str | None, bucket_name: str | None) -> None:
    if not (key_id and application_key and bucket_name):
        raise HTTPException(400, "Key ID, application key, and bucket name are all required.")
    get_bucket(key_id, application_key, bucket_name)
