PUBLIC FRONTEND FILES

Copy all files in this folder into the repository's public/ folder.

Required backend endpoints:
- GET /api/dashboard
- GET /api/servicestatus
- GET /api/dashboard/recent?limit=20

Expected Express setup:
  app.use(express.static("public"));

If the Node.js process starts from the repository root, the line above is sufficient.
The service worker caches only the frontend application shell. API responses remain network-only so maintenance data is never silently stale.
