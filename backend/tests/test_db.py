from app.database import supabase
import json

resp = supabase.table("business_knowledge").select("*").limit(1).execute()
print(resp.data)
