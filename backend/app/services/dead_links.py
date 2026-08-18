"""Learner-reported dead links, fed back into source discovery.

``link_check`` filters a static blocklist and whatever it can detect over HTTP.
Neither notices a page that died yesterday, or a host that quietly started
walling its content. A learner who hits a bad result reports it here, and the
report is honoured on their next search:

  * the exact URL never comes back,
  * a host they have reported ``HOST_STRIKES`` distinct URLs on is dropped
    wholesale — one bad page is bad luck, three is a bad site.

Reports are per learner and never shared, so one account can't poison another's
results. Reads degrade to "nothing reported" if the table is missing, which
keeps discovery working on a deployment where the migration hasn't run yet.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlparse

from app.database import get_supabase

logger = logging.getLogger(__name__)

TABLE = "dead_link_reports"
REASONS = ("dead", "paywalled", "irrelevant")
# Distinct reported URLs on one host before the whole host is dropped.
HOST_STRIKES = 3
# A cap so one learner's history can't grow the discovery query without bound.
MAX_REPORTS_READ = 2000


def normalise_host(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


class Blocklist:
    """One learner's reported URLs, plus the hosts they've given up on."""

    def __init__(self, urls: set[str], hosts: set[str]) -> None:
        self.urls = urls
        self.hosts = hosts

    def __bool__(self) -> bool:
        return bool(self.urls or self.hosts)


EMPTY = Blocklist(set(), set())


_warned = False


def for_user(user_id: str) -> Blocklist:
    """What this learner has reported. Never raises — discovery must still run."""
    global _warned
    try:
        rows = (
            get_supabase().table(TABLE).select("url, host")
            .eq("user_id", user_id).limit(MAX_REPORTS_READ).execute()
        ).data or []
    except Exception as exc:  # noqa: BLE001 — table may predate the migration
        # Once per process: a deployment running before the migration would
        # otherwise log this on every single search.
        if not _warned:
            _warned = True
            logger.warning("dead-link blocklist unavailable: %s", exc)
        return EMPTY

    urls = {(r.get("url") or "").strip() for r in rows if r.get("url")}
    strikes: dict[str, int] = {}
    for row in rows:
        host = (row.get("host") or "").strip()
        if host:
            strikes[host] = strikes.get(host, 0) + 1
    hosts = {h for h, n in strikes.items() if n >= HOST_STRIKES}
    return Blocklist(urls, hosts)


def report(user_id: str, url: str, reason: str = "dead") -> dict[str, Any]:
    """Record a report. Idempotent per (learner, url)."""
    row = {
        "user_id": user_id,
        "url": url[:1000],
        "host": normalise_host(url)[:255],
        "reason": reason if reason in REASONS else "dead",
    }
    result = (
        get_supabase().table(TABLE)
        .upsert(row, on_conflict="user_id,url").execute()
    )
    return (result.data or [row])[0]


def unreport(user_id: str, url: str) -> None:
    """Undo a report — the learner got it wrong, or the page came back."""
    get_supabase().table(TABLE).delete().eq("user_id", user_id).eq(
        "url", url
    ).execute()
