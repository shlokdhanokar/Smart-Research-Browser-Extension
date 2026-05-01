from sqlalchemy import Column, String, Integer, Float, DateTime, Text, LargeBinary
from pgvector.sqlalchemy import Vector
from app.database import Base
import uuid
from datetime import datetime


class CapturedPage(Base):
    __tablename__ = "captured_pages"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    url = Column(String(2000), unique=True, nullable=False, index=True)
    title = Column(String(500))
    content = Column(Text)
    summary = Column(Text)
    domain = Column(String(255), index=True)
    time_spent = Column(Integer)
    scroll_percent = Column(Float)
    word_count = Column(Integer)
    embedding = Column(Vector(1024))  # Cohere embed-english-v3.0 dimensions
    captured_at = Column(DateTime, default=datetime.utcnow, index=True)
    thumbnail = Column(LargeBinary, nullable=True)
