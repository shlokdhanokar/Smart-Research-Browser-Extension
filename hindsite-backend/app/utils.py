import re
from urllib.parse import urlparse


def extract_domain(url: str) -> str:
    """Extract domain (hostname) from URL."""
    try:
        return urlparse(url).netloc or url
    except Exception:
        return url


def extract_title_from_content(content: str, url: str) -> str:
    """Return first line of content if short enough, otherwise domain from URL."""
    if content:
        lines = content.strip().split("\n")
        first_line = lines[0].strip() if lines else ""
        if first_line and len(first_line) < 150:
            return first_line
    return extract_domain(url)


def clean_content(text: str) -> str:
    """Remove excessive whitespace and normalize text."""
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    text = " ".join(word for word in text.split() if len(word) < 50)
    return text.strip()
