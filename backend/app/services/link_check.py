"""Validation for web resources suggested by the Chat tab's source discovery.

The model returns plausible-looking links; a fair share of them 404, sit behind
a paywall, or point at a Google grounding redirect rather than the real page.
Every candidate is therefore checked before it reaches the learner:

  * blocked hosts — paywalled publishers, closed journals and answer mills —
    are dropped outright,
  * redirects are followed so the learner gets the destination URL, and the
    final host is re-checked against the blocklist,
  * the page must actually answer (HTTP 2xx); HEAD first, falling back to a
    ranged GET for the many servers that dislike HEAD,
  * the returned HTML is sniffed for soft 404s and "subscribe to continue"
    interstitials, which answer 200 while showing nothing,
  * YouTube is checked through oEmbed, because a deleted or private video still
    serves a 200 watch page,
  * what survives is ranked for relevance to the query and truncated.

Checks run concurrently under one overall deadline: discovery is interactive, so
a slow host loses its place rather than holding up the response.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any
from urllib.parse import parse_qs, urlparse, urlunparse

import httpx

logger = logging.getLogger(__name__)

# Hosts that reliably charge, wall or otherwise waste a learner's time. Matched
# on the registrable suffix, so subdomains are covered too.
BLOCKED_HOSTS = frozenset({
    # Paywalled or metered publishers
    "medium.com", "towardsdatascience.com", "nytimes.com", "wsj.com", "ft.com",
    "economist.com", "bloomberg.com", "theatlantic.com", "wired.com",
    "newscientist.com", "hbr.org", "seekingalpha.com",
    # Closed academic publishers — abstract only without an institution
    "sciencedirect.com", "springer.com", "link.springer.com", "jstor.org",
    "wiley.com", "onlinelibrary.wiley.com", "tandfonline.com", "sagepub.com",
    "ieee.org", "ieeexplore.ieee.org", "acm.org", "dl.acm.org", "nature.com",
    "science.org", "cambridge.org", "oup.com", "academic.oup.com",
    "emerald.com", "degruyter.com",
    # Registration walls / answer mills — not free study material
    "chegg.com", "coursehero.com", "scribd.com", "studocu.com", "numerade.com",
    "quizlet.com", "brainly.com", "academia.edu", "researchgate.net",
    "slideshare.net", "docsity.com", "bartleby.com",
})

# Phrases that mean "200 OK, but you can't read it".
PAYWALL_MARKERS = (
    "subscribe to continue", "subscribe to read", "become a member to read",
    "member-only story", "this story is for members", "create an account to read",
    "sign in to read", "log in to continue", "start your free trial",
    "you've reached your limit", "you have reached your article limit",
    "unlock this article", "purchase access", "get access to the full text",
    "buy this article", "institutional login",
)

# Soft 404s — a "not found" page served with a 200.
MISSING_MARKERS = (
    "page not found", "404 not found", "page cannot be found",
    "page doesn't exist", "page does not exist", "no longer available",
    "this content is unavailable", "video unavailable",
)

# Enough of the page to see a title and any interstitial, without downloading a
# whole PDF or a media file.
SNIFF_BYTES = 60_000
PER_REQUEST_TIMEOUT = 6.0
# The whole validation pass — discovery is interactive, so this is a budget, not
# a target. Anything still in flight when it expires is dropped.
TOTAL_TIMEOUT = 12.0
MAX_CONCURRENCY = 8

# A plain httpx UA collects 403s from CDNs; identify as a normal browser.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

# Tracking parameters, stripped so two spellings of a link dedupe against
# each other.
TRACKING_PARAMS = ("utm_", "fbclid", "gclid", "mc_cid", "mc_eid", "ref_src")

STOPWORDS = frozenset({
    "the", "and", "for", "with", "that", "this", "from", "what", "when", "where",
    "which", "how", "why", "are", "was", "were", "you", "your", "about", "into",
    "can", "does", "did", "has", "have", "will", "would", "should", "explain",
    "find", "free", "resources", "resource", "video", "videos", "tutorial",
    "tutorials", "guide", "guides", "notes", "study", "learn", "learning",
    "course", "courses", "best", "good", "some", "any", "please",
})

TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
SCRIPT_STYLE_RE = re.compile(
    r"<(script|style)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL
)


# --- URL handling -----------------------------------------------------------
def _is_blocked(url: str, extra_hosts: frozenset[str] | set[str] = frozenset()) -> bool:
    """Is this URL's host on the static blocklist, or one the learner rejected?"""
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return True
    parts = host.split(".")
    # Match the host and every parent domain: news.medium.com -> medium.com.
    return any(
        ".".join(parts[i:]) in BLOCKED_HOSTS or ".".join(parts[i:]) in extra_hosts
        for i in range(len(parts) - 1)
    )


def _canonical(url: str) -> str:
    """Normalised form used only for de-duplication."""
    parsed = urlparse(url)
    query = "&".join(
        part for part in (parsed.query or "").split("&")
        if part and not part.lower().startswith(TRACKING_PARAMS)
    )
    path = parsed.path.rstrip("/") or "/"
    return urlunparse((
        parsed.scheme.lower(), (parsed.hostname or "").lower(), path, "", query, "",
    ))


def _youtube_id(url: str) -> str | None:
    """The video id, for any of YouTube's URL shapes."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host.endswith("youtu.be"):
        return parsed.path.lstrip("/").split("/")[0] or None
    if "youtube.com" not in host:
        return None
    if parsed.path.startswith(("/embed/", "/v/", "/shorts/")):
        return parsed.path.split("/")[2] if len(parsed.path.split("/")) > 2 else None
    return (parse_qs(parsed.query).get("v") or [None])[0]


# --- Relevance --------------------------------------------------------------
def _keywords(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9+#]{3,}", (text or "").lower())
    return {w for w in words if w not in STOPWORDS}


def _relevance(
    query: str, resource: dict[str, Any], page_title: str = "", body: str = "",
) -> float:
    """Share of the query's meaningful words that show up in the resource.

    The page's own text counts, not just its title — the GNU Bash manual is a
    fine answer to "linux command line basics" despite saying none of those
    words in its title. Deliberately generous: this exists to drop results with
    nothing to do with the question, not to rank them finely.
    """
    wanted = _keywords(query)
    if not wanted:
        return 1.0
    haystack = _keywords(
        f"{resource.get('title', '')} {page_title} {resource.get('url', '')} "
        f"{body[:BODY_MATCH_CHARS]}"
    )
    return sum(1 for w in wanted if w in haystack) / len(wanted)


# A result is only dropped as off-topic when it shares *nothing* with the query
# — not one word in its title, URL or text. Anything above that is kept and
# ranked by score: an empty result list serves a learner far worse than a
# loosely related one, and this filter runs after the dead-and-walled checks
# have already done the heavy lifting.
MIN_RELEVANCE = 1e-9
# How much of a page's text is read for relevance — enough to cover the lead,
# not so much that every page matches everything.
BODY_MATCH_CHARS = 20_000


# --- Fetching ---------------------------------------------------------------
async def _request(
    client: httpx.AsyncClient, method: str, url: str, **kwargs: Any,
) -> httpx.Response:
    """One request, retried once on a transport error.

    A dropped connection or a timed-out handshake says nothing about the link —
    without a retry, a momentary blip silently costs the learner a good result.
    A status code, by contrast, is an answer and is never retried.
    """
    try:
        return await client.request(method, url, **kwargs)
    except httpx.TransportError as exc:
        logger.debug("retrying %s %s after %s", method, url, exc)
        return await client.request(method, url, **kwargs)



def _page_text(body: bytes, content_type: str) -> tuple[str, str]:
    """(lowercased page text, page title) from a sniffed response body."""
    if "html" not in content_type:
        return "", ""
    html = body.decode("utf-8", errors="ignore")
    match = TITLE_RE.search(html)
    title = TAG_RE.sub("", match.group(1)).strip() if match else ""
    # Drop script/style blocks before stripping tags, so their contents don't
    # end up in the text used for paywall and relevance matching.
    stripped = SCRIPT_STYLE_RE.sub(" ", html)
    return TAG_RE.sub(" ", stripped).lower(), title


async def _check_one(
    client: httpx.AsyncClient, resource: dict[str, Any], query: str,
    rejected_hosts: set[str] | None = None,
    rejected_urls: set[str] | None = None,
) -> dict[str, Any] | None:
    """Return the resource with its final URL, or None if it doesn't qualify."""
    url = resource["url"]

    video_id = _youtube_id(url)
    if video_id:
        return await _check_youtube(client, resource, video_id, query)

    try:
        response = await _request(client, "HEAD", url)
        # Plenty of servers dislike HEAD; retry those with a ranged GET.
        if response.status_code in (403, 404, 405, 409, 501) or response.status_code >= 500:
            response = await _request(
                client, "GET", url, headers={"Range": "bytes=0-60000"}
            )
    except httpx.HTTPError as exc:
        logger.debug("link check failed for %s: %s", url, exc)
        return None

    if response.status_code >= 400:
        return None

    final_url = str(response.url)
    # A redirect can land on a walled host, or on something the learner has
    # already reported under its destination URL.
    if _is_blocked(final_url, rejected_hosts or set()):
        return None
    if _canonical(final_url) in (rejected_urls or set()):
        return None

    body, page_title = b"", ""
    content_type = (response.headers.get("content-type") or "").lower()
    if response.request.method == "GET":
        body = response.content[:SNIFF_BYTES]
    elif "html" in content_type:
        # HEAD told us it's a page; fetch enough of it to spot a wall.
        try:
            body_response = await _request(
                client, "GET", url, headers={"Range": "bytes=0-60000"}
            )
            body = body_response.content[:SNIFF_BYTES]
            content_type = (body_response.headers.get("content-type") or "").lower()
            final_url = str(body_response.url)
        except httpx.HTTPError:
            body = b""

    text, page_title = _page_text(body, content_type)
    if text:
        if any(marker in text for marker in PAYWALL_MARKERS):
            return None
        if any(marker in text for marker in MISSING_MARKERS):
            return None

    score = _relevance(query, {**resource, "url": final_url}, page_title, text)
    if score < MIN_RELEVANCE:
        return None

    return {**resource, "url": final_url, "_score": score}


async def _check_youtube(
    client: httpx.AsyncClient, resource: dict[str, Any], video_id: str, query: str,
) -> dict[str, Any] | None:
    """A deleted or private video still serves a 200 watch page; oEmbed doesn't."""
    watch_url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        response = await _request(
            client, "GET", "https://www.youtube.com/oembed",
            params={"url": watch_url, "format": "json"},
        )
    except httpx.HTTPError as exc:
        logger.debug("youtube check failed for %s: %s", video_id, exc)
        return None
    if response.status_code != 200:
        return None

    try:
        title = (response.json() or {}).get("title") or ""
    except ValueError:
        title = ""

    score = _relevance(query, resource, title)
    if score < MIN_RELEVANCE:
        return None
    return {
        **resource,
        "url": watch_url,
        "title": resource.get("title") or title,
        "type": "youtube",
        "_score": score,
    }


# --- Entry point ------------------------------------------------------------
async def validate_resources(
    resources: list[dict[str, Any]], *, query: str = "", limit: int = 6,
    reported_urls: set[str] | None = None,
    reported_hosts: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Keep only the freely readable, working, on-topic resources.

    ``reported_urls`` and ``reported_hosts`` come from what this learner has
    flagged as dead or walled (see ``app.services.dead_links``); they're applied
    before any request goes out, so a rejected link costs nothing to skip.
    """
    rejected_urls = {_canonical(u) for u in (reported_urls or set())}
    rejected_hosts = reported_hosts or set()

    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for resource in resources:
        url = (resource.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        if _is_blocked(url, rejected_hosts):
            continue
        key = _canonical(url)
        if key in seen or key in rejected_urls:
            continue
        seen.add(key)
        candidates.append({**resource, "url": url})

    if not candidates:
        return []

    semaphore = asyncio.Semaphore(MAX_CONCURRENCY)

    async def guarded(client, resource):
        async with semaphore:
            try:
                return await _check_one(
                    client, resource, query, rejected_hosts, rejected_urls
                )
            except Exception as exc:  # noqa: BLE001 — one bad link isn't fatal
                logger.debug("link check errored for %s: %s", resource.get("url"), exc)
                return None

    headers = {"User-Agent": USER_AGENT, "Accept-Language": "en"}
    kept: list[dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=PER_REQUEST_TIMEOUT, headers=headers,
            max_redirects=5,
        ) as client:
            tasks = [asyncio.create_task(guarded(client, r)) for r in candidates]
            # Whatever cleared the budget still counts — a single slow host
            # shouldn't cost the learner every other result.
            done, pending = await asyncio.wait(tasks, timeout=TOTAL_TIMEOUT)
            for task in pending:
                task.cancel()
            if pending:
                logger.warning(
                    "resource validation dropped %d slow link(s) at its %.0fs budget",
                    len(pending), TOTAL_TIMEOUT,
                )
            kept = [t.result() for t in done if not t.cancelled() and t.result()]
    except Exception as exc:  # noqa: BLE001 — never fail discovery over this
        logger.warning("resource validation failed: %s", exc)
        return []
    # De-duplicate again: two candidates can redirect to the same destination.
    unique: dict[str, dict[str, Any]] = {}
    for resource in kept:
        unique.setdefault(_canonical(resource["url"]), resource)

    ranked = sorted(unique.values(), key=lambda r: r.get("_score", 0), reverse=True)
    return [{k: v for k, v in r.items() if k != "_score"} for r in ranked[:limit]]
