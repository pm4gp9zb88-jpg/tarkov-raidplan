RAIDPLAN 1.0 — WIKI-VALIDATED DATA PIPELINE

WHAT CHANGED
RaidPlan now supports a two-source data sync:
1. json.tarkov.dev supplies structured quest/trader/map/item data.
2. The Escape from Tarkov Fandom Wiki validates the CURRENT objective list.

WHY
A task API can lag behind a wipe. The Wiki may visually cross out removed objectives.
Plain-text imports can still see that old text, so RaidPlan now reads the Wiki's rendered
objective section and removes objectives that are struck out or no longer present.

AUTOMATIC SYNC
Run:
    node sync-data.mjs

It generates:
    tasks.snapshot.json
    data-audit.json

The website prefers tasks.snapshot.json. If it is missing, the old live Tarkov.dev importer
remains as a fallback.

AUTOMATIC DAILY UPDATES AFTER GITHUB
This project includes:
    .github/workflows/refresh-task-data.yml

Once the project is in GitHub, GitHub Actions runs the sync daily, commits the refreshed
snapshot, and a connected Netlify site can redeploy automatically.

IMPORTANT CONSERVATIVE BEHAVIOUR
If the Wiki page cannot be parsed confidently, the sync DOES NOT delete quest data.
It keeps the Tarkov.dev task and records the failure in data-audit.json.

HUMANITARIAN SUPPLIES
The examples folder contains a small validation example showing the current Wiki objective list:
- mark first truck with MS2000
- mark second truck with MS2000
- obtain 5 MREs
- hand over 5 MREs
No UNTAR kill requirement is generated.

FIRST FULL SYNC
There is intentionally NO partial tasks.snapshot.json in the live project root.
Until the first sync completes, RaidPlan falls back to its existing live Tarkov.dev importer.
Run `node sync-data.mjs` on a machine with internet access, or let the included GitHub Action run,
to create the complete Wiki-validated tasks.snapshot.json and data-audit.json.

DATA SOURCES
- https://json.tarkov.dev
- https://escapefromtarkov.fandom.com/wiki/Category:Quests
RaidPlan is unofficial and is not affiliated with Battlestate Games.
