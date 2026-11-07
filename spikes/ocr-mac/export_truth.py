"""Export answer key (human-reviewed markdown) + laptop baseline (raw) from DB copy."""
import json, sqlite3, sys
from pathlib import Path

DOC_KEYS = {
    "20260428---mbb---bctc-rieng-le-q1.2026.pdf": "q1-2026",
    "20251026---mbb---bctc-hop-nhat-q3.2025-viet.pdf": "q3-2025",
    "20260128---mbb---bao-cao-tai-chinh-hop-nhat-quy-4-2025.pdf": "q4-2025",
}
BACKEND = Path(__file__).resolve().parents[2] / "Financial_analyze" / "backend"
db = sqlite3.connect("helix-copy.db")
rows = db.execute("""
  select i.filename, i.storage_path, p.page_number, p.review_status, p.raw_markdown, p.reviewed_markdown
  from ocr_page_results p join ocr_attempts a on a.id=p.attempt_id
  join ocr_inbox_items i on i.id=a.inbox_item_id where p.review_status!='pending'""").fetchall()
manifest = []
for fn, sp, page, status, raw, reviewed in rows:
    key = f"{DOC_KEYS[fn]}_p{page:02d}"
    truth = reviewed if reviewed else raw  # approved = raw accepted as-is
    Path(f"truth/{key}.md").write_text(truth)
    Path(f"laptop/{key}.md").write_text(raw)
    manifest.append({"key": key, "pdf": str(BACKEND / sp), "page": page, "status": status})
Path("manifest.json").write_text(json.dumps(manifest, indent=2))
print(len(manifest), "pages exported")
