from dotenv import load_dotenv
load_dotenv('.env')
from composio import Composio
import os
import asyncio
composio = Composio(api_key=os.environ['COMPOSIO_API_KEY'])

accounts = composio.connected_accounts.get()
for acc in accounts:
    if acc.appId == 'googlesheets':
        print("Connected Account ID:", acc.id)
        # Try to use the tool
        try:
            result = composio.tools.execute(
                slug='googlesheets_search_spreadsheets',
                arguments={'query': 'Outreach'},
                entity_id=acc.connectionParams.get('entityId', acc.id) if hasattr(acc, 'connectionParams') else acc.id
            )
            print("Search Result:", result)
        except Exception as e:
            print("Error:", e)
