import re
import requests
from bs4 import BeautifulSoup

def _inject_url_content(prompt: str) -> str:
    url_pattern = re.compile(r'https?://[^\s<>"]+|www\.[^\s<>"]+')
    urls = set(url_pattern.findall(prompt))
    if not urls:
        return prompt
    
    appended_content = "\n\n--- External Content Extracted from URLs ---\n"
    added = False
    for url in urls:
        try:
            headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code == 200:
                soup = BeautifulSoup(resp.text, 'html.parser')
                text = soup.get_text(separator=' ', strip=True)
                text = text[:1000] # truncate for test
                appended_content += f"\nContent from {url}:\n{text}\n"
                added = True
        except Exception as e:
            print(f"Failed to fetch {url}: {e}")
            
    if added:
        return prompt + appended_content
    return prompt

print(_inject_url_content("Summarize this: https://example.com"))
