"""Fuzzy Resource Matching & Introspection Resolution Service.

Provides high-precision similarity scoring and closest-match resolution for
connected SaaS resources (Google Sheets, Google Drive files, Slack channels,
databases, repositories, etc.).

Ensures:
1. Exact or near-exact matches (typos, casing, partial titles) resolve to the
   correct resource automatically.
2. Irrelevant or unrelated inputs (below confidence threshold) are rejected
   rather than blindly assumed or defaulted to arbitrary items.
"""

import difflib
import re
from typing import Any, Dict, List, Optional, Tuple

# Common conversational/technical filler words to ignore during similarity scoring
_FILLER_WORDS = {
    "the", "my", "a", "an", "sheet", "sheets", "spreadsheet", "spreadsheets",
    "file", "files", "doc", "docs", "document", "documents", "table", "tables",
    "channel", "channels", "account", "database", "databases", "named", "called",
    "use", "using", "in", "from", "to", "for", "on", "our", "bot", "app",
}


def clean_resource_token(text: str) -> str:
    """Normalize a resource name for fair comparison:
    lowercased, punctuation-stripped, and excess whitespace removed.
    """
    if not text:
        return ""
    # Replace separators with space
    cleaned = re.sub(r"[-_/:;.,#|]+", " ", str(text).lower().strip())
    # Collapse whitespace
    return re.sub(r"\s+", " ", cleaned).strip()


def extract_meaningful_tokens(text: str) -> List[str]:
    """Extract non-filler tokens from a resource name."""
    clean = clean_resource_token(text)
    tokens = clean.split()
    meaningful = [t for t in tokens if t not in _FILLER_WORDS and len(t) > 1]
    return meaningful or tokens


def calculate_resource_similarity(candidate: str, target: str) -> float:
    """Calculate a comprehensive similarity score between candidate and target [0.0 - 1.0].
    
    Combines:
    1. Exact cleaned match (1.0)
    2. Substring & containment check (with length weighting)
    3. Token coverage & Jaccard overlap (order-independent)
    4. Character SequenceMatcher ratio (typos & transpositions)
    """
    cand_clean = clean_resource_token(candidate)
    target_clean = clean_resource_token(target)

    if not cand_clean or not target_clean:
        return 0.0

    # 1. Exact match
    if cand_clean == target_clean:
        return 1.0

    # 2. Token extraction
    cand_tokens = extract_meaningful_tokens(candidate)
    target_tokens = extract_meaningful_tokens(target)

    cand_set = set(cand_tokens)
    target_set = set(target_tokens)

    # Token overlap calculation
    token_score = 0.0
    if cand_set and target_set:
        intersection = cand_set.intersection(target_set)
        if intersection:
            coverage = len(intersection) / len(cand_set)
            jaccard = len(intersection) / len(cand_set.union(target_set))
            token_score = (coverage * 0.6) + (jaccard * 0.4)

    # 3. Substring containment check
    containment_score = 0.0
    if cand_clean in target_clean or target_clean in cand_clean:
        min_len = min(len(cand_clean), len(target_clean))
        max_len = max(len(cand_clean), len(target_clean))
        # If the candidate covers a major portion of the target or vice versa
        ratio = min_len / max_len if max_len > 0 else 0.0
        containment_score = 0.70 + (0.25 * ratio)

    # 4. Character sequence similarity (difflib)
    seq_ratio = difflib.SequenceMatcher(None, cand_clean, target_clean).ratio()

    # Also test sequence ratio without filler words
    meaningful_cand = " ".join(cand_tokens)
    meaningful_target = " ".join(target_tokens)
    meaningful_ratio = (
        difflib.SequenceMatcher(None, meaningful_cand, meaningful_target).ratio()
        if meaningful_cand and meaningful_target
        else 0.0
    )

    best_seq = max(seq_ratio, meaningful_ratio)

    # Combined score
    score = max(token_score, containment_score, best_seq)

    # If both token overlap and sequence ratio are strong, boost confidence
    if token_score >= 0.5 and best_seq >= 0.5:
        score = min(1.0, score + 0.1)

    return round(score, 4)


def find_closest_resource_match(
    candidate: str,
    candidates_list: List[str],
    threshold: float = 0.55,
) -> Tuple[Optional[str], float]:
    """Find the closest matching string in candidates_list for candidate.
    
    Returns:
        (best_match, score) if score >= threshold
        (None, score) if best match is below threshold (irrelevant detail)
    """
    if not candidate or not candidates_list:
        return None, 0.0

    best_match = None
    best_score = 0.0

    for item in candidates_list:
        if not isinstance(item, str):
            continue
        score = calculate_resource_similarity(candidate, item)
        if score > best_score:
            best_score = score
            best_match = item

    if best_score >= threshold:
        return best_match, best_score
    return None, best_score


def extract_resource_item_name(item: Dict[str, Any]) -> str:
    """Extract a human-readable title/name from a tool's result object."""
    if not isinstance(item, dict):
        return ""
    for k in (
        "name", "title", "summary", "channel_name", "full_name",
        "label", "subject", "filename", "spreadsheet_name",
    ):
        v = item.get(k)
        if v and isinstance(v, str):
            return v.strip()
    return ""


def find_closest_resource_item(
    candidate: str,
    items: List[Dict[str, Any]],
    threshold: float = 0.55,
) -> Tuple[Optional[Dict[str, Any]], float]:
    """Find the closest matching dictionary item based on its name/title.
    
    Returns:
        (best_item, score) if score >= threshold
        (None, score) if best match is below threshold (irrelevant detail)
    """
    if not candidate or not items:
        return None, 0.0

    best_item = None
    best_score = 0.0

    for item in items:
        if not isinstance(item, dict):
            continue
        name = extract_resource_item_name(item)
        if not name:
            continue
        score = calculate_resource_similarity(candidate, name)
        if score > best_score:
            best_score = score
            best_item = item

    if best_score >= threshold:
        return best_item, best_score
    return None, best_score

