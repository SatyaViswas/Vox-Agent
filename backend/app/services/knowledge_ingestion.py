import io
import pandas as pd
import fitz  # PyMuPDF
from bs4 import BeautifulSoup
import requests
from typing import List, Tuple
from google import genai
from app.config import settings
from app.database import supabase
import uuid

# Initialize Gemini Client for embeddings
genai_client = genai.Client(api_key=settings.GEMINI_API_KEY) if settings.GEMINI_API_KEY else None

def get_embedding(text: str) -> List[float]:
    """Get embedding for a text chunk using Gemini."""
    if not genai_client:
        raise ValueError("GEMINI_API_KEY is not set. Cannot generate embeddings.")
    
    response = genai_client.models.embed_content(
        model='gemini-embedding-2',
        contents=text,
        config=genai.types.EmbedContentConfig(output_dimensionality=768)
    )
    return response.embeddings[0].values

def chunk_text(text: str, chunk_size: int = 1000, overlap: int = 200) -> List[str]:
    """Basic character-based chunking with overlap."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        chunks.append(chunk)
        start += chunk_size - overlap
    return chunks

def extract_text_from_url(url: str) -> str:
    """Scrape text from a URL."""
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.content, "html.parser")
        
        # Remove script and style elements
        for script in soup(["script", "style", "nav", "footer", "header"]):
            script.extract()
            
        text = soup.get_text(separator=' ')
        # Clean up whitespace
        lines = (line.strip() for line in text.splitlines())
        chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
        text = ' '.join(chunk for chunk in chunks if chunk)
        return text
    except Exception as e:
        raise Exception(f"Failed to scrape URL {url}: {str(e)}")

def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract text from PDF using PyMuPDF."""
    text = ""
    try:
        pdf_document = fitz.open(stream=file_bytes, filetype="pdf")
        for page_num in range(pdf_document.page_count):
            page = pdf_document.load_page(page_num)
            text += page.get_text() + "\n\n"
    except Exception as e:
        raise Exception(f"Failed to parse PDF: {str(e)}")
    return text

def extract_text_from_csv(file_bytes: bytes) -> str:
    """Extract text from CSV using pandas."""
    try:
        df = pd.read_csv(io.BytesIO(file_bytes))
        # Convert each row into a readable text format
        text_lines = []
        for index, row in df.iterrows():
            row_text = ", ".join([f"{col}: {val}" for col, val in row.items()])
            text_lines.append(row_text)
        return "\n".join(text_lines)
    except Exception as e:
        raise Exception(f"Failed to parse CSV: {str(e)}")

def process_and_store_knowledge(
    user_id: str, 
    source_type: str, 
    source_name: str, 
    content: str
) -> int:
    """Chunks text, gets embeddings, and stores in Supabase."""
    if not supabase:
        raise ValueError("Supabase client is not initialized.")
        
    chunks = chunk_text(content)
    inserted_count = 0
    
    for chunk in chunks:
        if not chunk.strip():
            continue
            
        embedding = get_embedding(chunk)
        
        data = {
            "user_id": user_id,
            "source_type": source_type,
            "source_name": source_name,
            "content": chunk,
            "embedding": embedding
        }
        
        supabase.table("business_knowledge").insert(data).execute()
        inserted_count += 1
        
    # Invalidate cache for this user since new knowledge was added
    supabase.table("semantic_cache").delete().eq("user_id", user_id).execute()
    
    return inserted_count
