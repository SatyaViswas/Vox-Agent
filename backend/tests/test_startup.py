from fastapi import FastAPI
app = FastAPI()
@app.on_event("startup")
async def startup():
    with open("startup_ran.txt", "w") as f:
        f.write("ran")
