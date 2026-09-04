from google import genai
from dotenv import load_dotenv

load_dotenv()
client = genai.Client()
for model in ["gemini-embedding-2", "text-embedding-004", "gemini-embedding-001"]:
    try:
        resp = client.models.embed_content(model=model, contents="hello")
        print(f"{model}: {len(resp.embeddings[0].values)} dims")
    except Exception as e:
        print(f"{model} failed: {e}")
