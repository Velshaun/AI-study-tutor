"""Getting videos out of YouTube — the list of them, not the watching of them.

The whole point of the feature is that nobody sits through six hours of a course
to revise from it. Transcripts are the material; the video is just where it
happens to live.

Two doors, and which is primary matters. **Pasting a URL** needs no API key and
no quota: a video id is enough to fetch a transcript, so that path keeps working
whatever else is exhausted. **Searching** needs the Data API, whose free tier
allows a hundred searches a day across everyone — so it is the convenience, not
the foundation, and the app degrades to paste-only rather than breaking when the
quota runs out.

Listing a playlist also needs the key, which is the one asymmetry worth knowing:
a pasted *video* works keyless, a pasted *playlist* does not.
"""

from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

API_ROOT = "https://www.googleapis.com/youtube/v3"
# playlistItems.list returns 50 at a time and costs one quota unit per call, so
# even a three-hundred-video playlist is six units. Search costs a hundred.
PAGE_SIZE = 50
TIMEOUT = 20.0


class YouTubeError(RuntimeError):
    """Something YouTube-shaped went wrong, with a learner-readable reason."""


class QuotaExhausted(YouTubeError):
    """The Data API is out of quota for the day — paste still works."""


def _key() -> str:
    key = (settings.youtube_api_key or "").strip()
    if not key:
        raise YouTubeError(
            "Searching YouTube needs an API key. You can still paste a video or "
            "playlist link — that works without one."
        )
    return key


# --- reading a URL ----------------------------------------------------------
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
PLAYLIST_ID = re.compile(r"^[A-Za-z0-9_-]{12,42}$")


def parse_target(url: str) -> dict[str, str] | None:
    """What a pasted YouTube link points at.

    Returns ``{"kind": "playlist"|"video", "id": ...}``. A watch URL that also
    carries a list parameter is treated as a playlist — someone who pastes that
    has the playlist open and means all of it.
    """
    raw = (url or "").strip()
    if not raw:
        return None
    parsed = urlparse(raw if "//" in raw else f"https://{raw}")
    host = (parsed.hostname or "").lower().removeprefix("www.")
    query = parse_qs(parsed.query or "")

    if host not in {"youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}:
        return None

    listed = (query.get("list") or [None])[0]
    if listed and PLAYLIST_ID.match(listed):
        return {"kind": "playlist", "id": listed}

    if host == "youtu.be":
        candidate = parsed.path.lstrip("/").split("/")[0]
        return {"kind": "video", "id": candidate} if VIDEO_ID.match(candidate) else None

    if parsed.path in ("/watch", "/watch/"):
        candidate = (query.get("v") or [""])[0]
        return {"kind": "video", "id": candidate} if VIDEO_ID.match(candidate) else None

    # /embed/ID, /v/ID, /shorts/ID, /live/ID
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) >= 2 and parts[0] in {"embed", "v", "shorts", "live"}:
        return {"kind": "video", "id": parts[1]} if VIDEO_ID.match(parts[1]) else None
    return None


# --- the Data API -----------------------------------------------------------
def _get(path: str, params: dict[str, Any]) -> dict[str, Any]:
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.get(f"{API_ROOT}/{path}",
                                  params={**params, "key": _key()})
    except YouTubeError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise YouTubeError(f"Could not reach YouTube: {exc}") from exc

    if response.status_code == 403:
        body = response.text.lower()
        if "quota" in body:
            raise QuotaExhausted(
                "YouTube search has hit its daily limit. Pasting a link still "
                "works — try that, or come back tomorrow."
            )
        raise YouTubeError("YouTube refused that request.")
    if response.status_code >= 400:
        raise YouTubeError(f"YouTube returned {response.status_code}.")
    return response.json()


def list_playlist(playlist_id: str, *, max_videos: int | None = None) -> list[dict[str, str]]:
    """Every video in a playlist, in playlist order.

    No cap by default: the decision was that a playlist means all of it. Order
    is preserved for display only — nothing infers a domain from position.
    """
    videos: list[dict[str, str]] = []
    page: str | None = None

    while True:
        data = _get("playlistItems", {
            "part": "snippet,contentDetails",
            "playlistId": playlist_id,
            "maxResults": PAGE_SIZE,
            **({"pageToken": page} if page else {}),
        })
        for item in data.get("items", []):
            details = item.get("contentDetails") or {}
            snippet = item.get("snippet") or {}
            video_id = details.get("videoId")
            title = (snippet.get("title") or "").strip()
            # Private and deleted videos stay in a playlist as tombstones with
            # no usable id or title. They are not failures to report — they were
            # never available.
            if not video_id or title.lower() in {"private video", "deleted video"}:
                continue
            videos.append({"video_id": video_id, "title": title})
            if max_videos and len(videos) >= max_videos:
                return videos

        page = data.get("nextPageToken")
        if not page:
            return videos


def playlist_title(playlist_id: str) -> str:
    data = _get("playlists", {"part": "snippet", "id": playlist_id, "maxResults": 1})
    items = data.get("items") or []
    return ((items[0].get("snippet") or {}).get("title") or "YouTube playlist") if items else "YouTube playlist"


def search(query: str, *, instructor: str | None = None,
           playlist: bool = True) -> dict[str, str] | None:
    """The top-ranked result for a course, as a target to import.

    One search, one result. Re-ranking candidates against the module's blueprint
    would be better and costs another hundred quota units per attempt, which the
    free tier cannot carry — so the honest position is that this is YouTube's
    judgement of relevance, not ours.
    """
    terms = " ".join(t for t in [query, instructor] if t and t.strip()).strip()
    if not terms:
        raise YouTubeError("Give a course or exam name to search for.")

    data = _get("search", {
        "part": "snippet",
        "q": terms,
        "type": "playlist" if playlist else "video",
        "maxResults": 1,
        "order": "relevance",
    })
    items = data.get("items") or []
    if not items:
        return None

    top = items[0]
    snippet = top.get("snippet") or {}
    ident = top.get("id") or {}
    if playlist and ident.get("playlistId"):
        return {"kind": "playlist", "id": ident["playlistId"],
                "title": (snippet.get("title") or "").strip()}
    if not playlist and ident.get("videoId"):
        return {"kind": "video", "id": ident["videoId"],
                "title": (snippet.get("title") or "").strip()}
    return None


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"
