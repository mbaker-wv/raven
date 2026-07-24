#!/usr/bin/env python3
"""Standalone disaster-recovery script.

Downloads the most recent database backup from Backblaze B2 into data/tracker.db.
Run this after cloning the repo and installing requirements, before starting the app.

Usage:
    python restore.py --key-id <id> --application-key <key> --bucket <name>

Credentials can also come from environment variables:
    B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME
"""
import argparse
import os
import sys
from pathlib import Path

from b2sdk.v2 import B2Api, InMemoryAccountInfo

BASE_DIR = Path(__file__).resolve().parent
DEST = BASE_DIR / "data" / "tracker.db"


def main():
    parser = argparse.ArgumentParser(description="Restore the Raven database from Backblaze B2.")
    parser.add_argument("--key-id", default=os.environ.get("B2_KEY_ID"))
    parser.add_argument("--application-key", default=os.environ.get("B2_APPLICATION_KEY"))
    parser.add_argument("--bucket", default=os.environ.get("B2_BUCKET_NAME"))
    args = parser.parse_args()

    if not (args.key_id and args.application_key and args.bucket):
        parser.error(
            "Provide --key-id/--application-key/--bucket, "
            "or set B2_KEY_ID/B2_APPLICATION_KEY/B2_BUCKET_NAME."
        )

    if DEST.exists():
        answer = input(f"{DEST} already exists. Overwrite it? [y/N] ").strip().lower()
        if answer != "y":
            print("Aborted.")
            sys.exit(1)

    info = InMemoryAccountInfo()
    b2_api = B2Api(info)
    print("Authorizing with Backblaze B2...")
    b2_api.authorize_account("production", args.key_id, args.application_key)
    bucket = b2_api.get_bucket_by_name(args.bucket)

    print("Looking for the latest database backup...")
    latest = None
    for file_version, _ in bucket.ls(latest_only=True):
        if file_version.file_name.startswith("tracker-") and file_version.file_name.endswith(".db"):
            if latest is None or file_version.upload_timestamp > latest.upload_timestamp:
                latest = file_version

    if latest is None:
        print(f"No database backups found in bucket '{args.bucket}'.")
        sys.exit(1)

    print(f"Downloading {latest.file_name}...")
    DEST.parent.mkdir(exist_ok=True)
    downloaded = bucket.download_file_by_name(latest.file_name)
    downloaded.save_to(str(DEST))

    print(f"Restored {latest.file_name} to {DEST}")
    print("Next: run the app (see README/RESTORE.md).")


if __name__ == "__main__":
    main()
