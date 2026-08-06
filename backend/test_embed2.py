from google import genai
from dotenv import load_dotenv

load_dotenv()
client = genai.Client()
for model in ["gemini-embedding-001", "gemini-embedding-2"]:
    try:
        resp = client.models.embed_content(
            model=model, 
            contents="hello",
            config=genai.types.EmbedContentConfig(output_dimensionality=768)
        )
        print(f"{model} (768): {len(resp.embeddings[0].values)} dims")
    except Exception as e:
        print(f"{model} failed: {e}")
