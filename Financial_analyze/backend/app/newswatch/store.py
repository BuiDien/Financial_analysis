"""Alert episode / dedupe store."""
from datetime import date

from ..models.newswatch import NewsAlert


def record_alert(db, *, kind, ticker, alert_date, verdict, message, facts, episode_open,
                 commit: bool = True) -> NewsAlert:
    """kind: holding | global | global_seen (a morning match the model judged not
    material: suppresses re-alerting on its URLs, does not count as the day's global alert)."""
    row = NewsAlert(kind=kind, ticker=ticker, alert_date=alert_date, verdict=verdict,
                    message=message, facts=facts, episode_open=episode_open)
    db.add(row)
    if commit:
        db.commit()
    return row


def global_alert_sent(db, day: date) -> bool:
    return db.query(NewsAlert.id).filter(NewsAlert.kind == "global",
                                         NewsAlert.alert_date == day).first() is not None


def alerted_urls(db, kinds: tuple[str, ...] = ("global", "global_seen")) -> set[str]:
    urls: set[str] = set()
    for (facts,) in db.query(NewsAlert.facts).filter(NewsAlert.kind.in_(kinds)):
        urls.update((facts or {}).get("urls") or [])
    return urls
