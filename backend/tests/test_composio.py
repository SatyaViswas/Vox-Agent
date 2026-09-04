import asyncio
from app.services.composio_engine import composio

def main():
    sub = composio.triggers.subscribe()
    print("Subscribed!", sub)
    # wait forever
    import time
    time.sleep(2)
    print("Done waiting")

main()
