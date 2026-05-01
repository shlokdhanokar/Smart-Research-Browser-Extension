import re
from typing import Optional, List
from app.schemas import OpenTab, TabSwitchResult


class QueryRouter:
    """Routes queries to tab_switch or semantic_search. Tab matching uses only
    the user's query words against the provided open tabs (url + title), not
    any fixed site list."""

    # Explicit phrases that indicate tab-switching intent (user said "switch to", etc.)
    TAB_SWITCH_PATTERNS = [
        r"^switch\s+to\s+",
        r"^go\s+to\s+",
        r"^open\s+",
        r"^move\s+to\s+",
        r"^show\s+",
        r"^jump\s+to\s+",
    ]

    # Minimum confidence to return a tab match (otherwise return None)
    MIN_CONFIDENCE = 0.5

    def detect_intent(self, query: str) -> str:
        """Determine if query is for tab switching or semantic search.
        Only explicit phrases (e.g. 'switch to', 'go to') trigger tab_switch;
        actual tab selection is always done by matching query words against
        the open tabs passed to find_matching_tab."""
        query_lower = query.lower().strip()

        for pattern in self.TAB_SWITCH_PATTERNS:
            if re.match(pattern, query_lower):
                return "tab_switch"

        return "semantic_search"

    def extract_search_terms(self, query: str) -> List[str]:
        """Extract meaningful search terms from the user's query (used only
        to match against open tab titles and URLs)."""
        query_lower = query.lower().strip()

        for pattern in self.TAB_SWITCH_PATTERNS:
            query_lower = re.sub(pattern, "", query_lower)

        words = [w for w in query_lower.split() if len(w) > 2]
        return words

    def find_matching_tab(
        self, query: str, tabs: List[OpenTab]
    ) -> Optional[TabSwitchResult]:
        """Find the best matching tab by comparing the user's query terms
        against each tab's url and title only. No fixed site list is used;
        matching is purely against the provided open tabs."""
        if not tabs:
            return None

        search_terms = self.extract_search_terms(query)
        if not search_terms:
            # Fallback: use full query as single term (e.g. "netflix")
            search_terms = [q for q in query.lower().strip().split() if q]

        best_match = None
        best_score = 0.0

        for tab in tabs:
            score = self._calculate_match_score(search_terms, tab)
            if score > best_score:
                best_score = score
                best_match = tab

        if best_match and best_score >= self.MIN_CONFIDENCE:
            return TabSwitchResult(
                tab_id=best_match.tab_id,
                window_id=best_match.window_id,
                url=best_match.url,
                title=best_match.title,
                confidence=round(best_score, 2),
            )

        return None

    def _calculate_match_score(self, search_terms: List[str], tab: OpenTab) -> float:
        """Score how well the user's query terms match this tab's title and url."""
        tab_text = f"{tab.title} {tab.url}".lower()

        matches = 0
        for term in search_terms:
            if term in tab_text:
                matches += 1

        if not search_terms:
            return 0.0

        return matches / len(search_terms)


query_router = QueryRouter()
