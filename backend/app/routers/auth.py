from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.database import supabase

router = APIRouter(prefix="/auth", tags=["auth"])

class SignupRequest(BaseModel):
    email: str
    password: str

@router.post("/signup")
async def admin_signup(req: SignupRequest):
    try:
        # We use the admin API to bypass rate limits and auto-confirm emails for this demo/hackathon
        # This requires SUPABASE_SERVICE_ROLE_KEY to be set in the supabase client initialization
        res = supabase.auth.admin.create_user({
            "email": req.email,
            "password": req.password,
            "email_confirm": True
        })
        
        # The postgres trigger 'on_auth_user_created' will automatically copy them to public.users
        return {"success": True, "message": "User created successfully"}
    except Exception as e:
        error_msg = str(e)
        if "already registered" in error_msg.lower():
            # If they are already registered, that's fine, the frontend will just log them in
            return {"success": True, "message": "User already exists"}
        raise HTTPException(status_code=400, detail=error_msg)
