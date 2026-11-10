"""SPIKE (throwaway): pull broker trade-report PDFs from Gmail over IMAP.

Read-only: opens INBOX/All Mail with readonly=True, never marks or deletes.
Usage:
    python3 pull_reports.py                # prompts for app password
    GMAIL_USER=you@gmail.com python3 pull_reports.py --query 'has:attachment filename:pdf Ket_Qua_Giao_Dich'
"""
import argparse
import email
import getpass
import imaplib
import os
from email.header import decode_header, make_header
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "downloads"


def dec(s):
    return str(make_header(decode_header(s))) if s else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default=os.environ.get("GMAIL_USER"))
    # Gmail search syntax (same as the Gmail search box), via X-GM-RAW.
    ap.add_argument("--query", default='subject:"Thông báo kết quả giao dịch" SSI has:attachment newer_than:60d')
    ap.add_argument("--limit", type=int, default=20)
    args = ap.parse_args()

    user = args.user or input("Gmail address: ").strip()
    pw = os.environ.get("GMAIL_APP_PASSWORD") or getpass.getpass("App password (hidden): ")
    pw = pw.replace(" ", "")

    M = imaplib.IMAP4_SSL("imap.gmail.com")
    M.login(user, pw)
    print("login ok")
    # Folder names are localized ("[Gmail]/Tất cả thư"...), so find All Mail by its \All flag.
    folder = '"INBOX"'
    typ, boxes = M.list()
    for line in boxes or []:
        s = line.decode(errors="replace")
        if "\\All" in s:
            folder = s[s.rindex(' "', 0, len(s) - 1) + 1:] if s.endswith('"') else s.rsplit(" ", 1)[-1]
            break
    typ, info = M.select(folder, readonly=True)
    print(f"folder {folder}: {typ} {info[0].decode(errors='replace')} messages")
    if typ != "OK":
        raise SystemExit("could not open folder")

    # Non-ASCII (Vietnamese) query must go as a UTF-8 literal, not a quoted string.
    M.literal = args.query.encode("utf-8")
    typ, data = M.search("UTF-8", "X-GM-RAW")
    ids = data[0].split()
    print(f"query: {args.query!r} -> {len(ids)} messages (showing last {args.limit})")
    OUT.mkdir(exist_ok=True)

    for mid in ids[-args.limit:]:
        typ, msg_data = M.fetch(mid, "(BODY.PEEK[])")  # PEEK = don't mark as read
        msg = email.message_from_bytes(msg_data[0][1])
        print(f"\n#{mid.decode()}  {msg['Date']}")
        print(f"  from:    {dec(msg['From'])}")
        print(f"  subject: {dec(msg['Subject'])}")
        for part in msg.walk():
            fn = part.get_filename()
            if not fn:
                continue
            fn = dec(fn)
            payload = part.get_payload(decode=True) or b""
            print(f"  attach:  {fn}  ({len(payload):,} bytes, {part.get_content_type()})")
            if fn.lower().endswith(".pdf"):
                dest = OUT / f"{mid.decode()}_{fn}"
                dest.write_bytes(payload)
                print(f"           saved -> {dest.relative_to(HERE)}")
    M.logout()


if __name__ == "__main__":
    main()
