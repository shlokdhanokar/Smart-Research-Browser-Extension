import cohere
import os
from dotenv import load_dotenv

load_dotenv()


class CohereEmbedder:
    def __init__(self):
        api_key = os.getenv("COHERE_API_KEY")
        if not api_key:
            raise ValueError(
                "COHERE_API_KEY is not set. Add it to your .env file."
            )
        self.client = cohere.Client(api_key)
        self.model = "embed-english-v3.0"

    def generate_document_embedding(self, text: str) -> list:
        """Generate embedding for a document/page. Uses 'search_document' input type."""
        text = text[:8000]  # Cohere's limit
        print("[HindSite SEMANTIC] [embed] Converting document to vector (model=%s, input_type=search_document, len=%d)" % (self.model, len(text)))
        response = self.client.embed(
            texts=[text],
            model=self.model,
            input_type="search_document",
        )
        emb = response.embeddings[0]
        print("[HindSite SEMANTIC] [embed] Document embedding done → dim=%d" % len(emb))
        return emb

    def generate_query_embedding(self, query: str) -> list:
        """Generate embedding for a search query. Uses 'search_query' input type."""
        query = query[:8000]
        print("[HindSite SEMANTIC] [embed] Converting query to vector (model=%s, input_type=search_query) query=%r" % (self.model, query))
        response = self.client.embed(
            texts=[query],
            model=self.model,
            input_type="search_query",
        )
        emb = response.embeddings[0]
        print("[HindSite SEMANTIC] [embed] Query embedding done → dim=%d" % len(emb))
        return emb


# Singleton instance
embedder = CohereEmbedder()
