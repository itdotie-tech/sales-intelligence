# IT.ie Revenue Intelligence — hosted app scaffold

This turns the existing standalone dashboard into a secured web app: hosted on
Azure Static Web Apps, gated by your Microsoft 365 (Entra ID) login, with a
**Connected data sources** panel that supports any number of automated feeds
— NetSuite for revenue, plus a CRM, a helpdesk, or anything else with an
API — so the manual upload becomes optional rather than required.

**Nothing about the dashboard itself changed.** The manual "drop your
workbook here" flow on the Data Hub page still works exactly as before. This
adds a second path — automated sources — that runs through the same
processing for revenue data, and stores anything else ready to use..

> For a fully detailed, click-by-click walkthrough, see the companion
> document **ITie-Revenue-Intelligence-Build-Guide.docx**. This README is the
> quick-reference version.

## What's in this folder

```
index.html                  the dashboard (same as before, plus multi-source support)
staticwebapp.config.json    Entra ID auth config for Azure Static Web Apps
api/getSource/               Azure Function serving any named source (/api/getSource/<id>)
api/host.json, package.json Function app plumbing
```

## How sources work

The Data Hub page has a **Connected data sources** panel. Each source is:

- **Primary** (one only) — feeds the dashboard's revenue/client model. This
  must return the same four sheets the workbook does: `Revenue_Fact`,
  `Client_Master`, `Device_Mapping`, `Gap_Analysis_Flags`. NetSuite is the
  primary source by default.
- **Secondary** (any number) — anything else. Fetched and stored as-is,
  ready for a future dashboard page to use, without touching the revenue
  figures at all. A CRM feed is included as an example.

Each source gets its own API route automatically: a source with id `crm`
is served at `/api/getSource/crm`, reading a blob named `crm.json`. Adding a
new source is: add it in the Data Hub UI → build a matching Power Automate
flow that writes `<id>.json` to the same storage container → click "Load
now". No code changes needed for a new source.

## Part 1 — Deploy the app

1. **Put this folder in a GitHub (or Azure DevOps) repo.** Azure Static Web
   Apps deploys straight from a repo via a GitHub Action it creates for you.
2. In the Azure Portal, create a **Static Web App** resource:
   - Plan: Free (upgrade to Standard, ~$9/month, only if you outgrow it)
   - Link it to the repo
   - App location: `/`
   - Api location: `api`
   - Output location: *(leave blank — this is plain HTML, no build step)*
3. Azure creates the GitHub Action automatically and deploys. First deploy
   takes a few minutes.

## Part 2 — Secure it with Entra ID

1. In **Entra ID admin center → App registrations → New registration**,
   register an app (e.g. "IT.ie Revenue Intelligence"). Redirect URI:
   `https://<your-app-name>.azurestaticapps.net/.auth/login/aad/callback`.
2. Under **Certificates & secrets**, create a client secret and copy it —
   it's only shown once.
3. Note three values: **Application (client) ID**, the **client secret**, and
   your **Directory (tenant) ID**.
4. In `staticwebapp.config.json`, replace `<YOUR_TENANT_ID>` with your actual
   tenant ID.
5. In the Static Web App resource → **Configuration → Application settings**,
   add:
   - `AAD_CLIENT_ID` = the Application (client) ID
   - `AAD_CLIENT_SECRET` = the client secret
6. Redeploy (push the config change). From here, opening the app prompts a
   normal Microsoft 365 login, and only people in your tenant can get in —
   nobody else can even see the login screen succeed.

## Part 3 — Storage for automated sources (optional)

Skip this entirely if you're happy keeping the manual upload as the only way
data gets in.

1. Create an **Azure Storage Account** (Standard, LRS is fine).
2. Create a **private container** named `data-sync`. Leave public access off.
3. Copy the storage account's **connection string** (Access keys page).
4. In the Static Web App's Application settings, add:
   - `AZURE_STORAGE_CONNECTION_STRING` = that connection string
   - `DATASET_CONTAINER` = `data-sync`

The `getSource` function reads `<id>.json` from this container for whichever
source is requested — but only after Static Web Apps' own login check
passes, so the storage connection string never reaches the browser and the
container itself stays private.

## Part 4 — Build a Power Automate flow per source

Each source follows the same shape:

**Trigger:** Recurrence — e.g. daily at 06:00 Dublin time.

**Steps:**
1. Call the source's API (NetSuite needs the HTTP action with Token-Based
   Authentication — a Premium connector, needs one Power Automate Premium
   seat; many CRMs have a ready-made standard connector, which is simpler).
2. Shape the result into JSON. For the **primary** NetSuite source, it must
   be exactly these four arrays with these column names:

   ```json
   {
     "Revenue_Fact": [ { "Date":"", "Master_Company":"", "Branch_Name":"",
       "Account":"", "Item":"", "Class":"", "Amount":0, "Quantity":0,
       "Service_Family":"", "Service_Tier":"", "Billing_Cadence":"",
       "Includes_CAT_CSAT":"", "Includes_VoIP":"" } ],
     "Client_Master": [ { "Master_Company":"", "Account_Manager":"",
       "Company_Device_Count":0 } ],
     "Device_Mapping": [ { "Device_Site":"", "Device_Count":0,
       "Mapped_Master_Company":"", "Mapped_Branch_Name":"" } ],
     "Gap_Analysis_Flags": [ { "Master_Company":"" } ]
   }
   ```

   For a **secondary** source (e.g. CRM), the shape is entirely up to you —
   whatever fields make sense for that system. It's stored as-is; a future
   dashboard page is what would give it meaning.
3. **Create blob** action (Azure Blob Storage connector) → container
   `data-sync`, blob name `<source-id>.json` (e.g. `netsuite.json`,
   `crm.json`), content = the JSON from step 2, overwrite on.

That's the whole flow: call the API → shape into JSON → overwrite one blob.
All the actual business logic (MRR normalisation, service classification,
capability mapping) stays in the dashboard's own JavaScript for the primary
source — the flow never needs to replicate any of that.

## Adding the source in the app

On the Data Hub page → Connected data sources → **+ Add data source**, give
it a name. The app generates its API route automatically
(`/api/getSource/<id>`). Point your Power Automate flow's blob name at the
same id, click **Load now**, and you'll see a record count and timestamp
confirming it's connected.

## Testing locally before deploying

You can open `index.html` directly in a browser at any point — the manual
upload works with no server at all, exactly as before. Feed sources simply
won't resolve locally (no `/api` route exists outside Azure), which is
expected and harmless — they fail silently and the app behaves exactly as it
does today.

## Cost recap

| Item | Cost |
|---|---|
| Static Web App (Free tier) | €0 |
| Blob Storage (a few small JSON files) | negligible, well under €1/month |
| Entra ID app registration | €0 (included in your tenant) |
| Power Automate Premium seat (NetSuite HTTP call) | ~€14/user/month, one seat |
| Each additional connector (often standard tier) | check per-connector, frequently €0 extra |

## Security summary

- Login is your existing Microsoft 365 identity — no separate password.
- Source credentials (NetSuite, CRM, etc.) live only inside each Power
  Automate connection, never in the app.
- The storage container holding synced data is private; only the Azure
  Function can read it, and only authenticated requests reach that function.
- Nothing in this setup sends IT.ie or client data to a third-party
  processor outside the Microsoft/Azure tenant boundary.

