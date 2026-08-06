from google import genai
from dotenv import load_dotenv
import os

load_dotenv()
client = genai.Client()
models = client.models.list()
for m in models:
    if 'embed' in m.name.lower():
        print(m.name)
