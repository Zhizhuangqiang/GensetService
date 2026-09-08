# Maintenance API for Render + Aiven PostgreSQL

This repository contains the Node.js REST API used by the maintenance dashboard.

## API routes

- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/dashboard/upcoming?days=30`
- `GET /api/dashboard/overdue`
- `GET /api/dashboard/recent?limit=20`

The SQL expects these tables and columns from the improved service schema:

- `projects`: `id`, `name`, `active`
- `gensets`: `id`, `project_id`, `name`, `equipment_tag`, `active`
- `service_categories`: `id`, `name`
- `service_items`: `id`, `category_id`, `name`, `active`
- `service_schedules`: `id`, `genset_id`, `service_item_id`, `period_days`, `warning_days`, `initial_due_date`, `active`
- `service_records`: `id`, `genset_id`, `service_item_id`, `service_date`, `engine_hours`, `performed_by`, `work_order_number`, `report_reference`, `remarks`
- `service_attachments`: `id`

## Upload to GitHub

1. Extract this ZIP.
2. Create an empty GitHub repository.
3. In the extracted folder run:

```bash
git init
git add .
git commit -m "Initial maintenance API"
git branch -M main
git remote add origin https://github.com/YOUR-USER/YOUR-REPO.git
git push -u origin main
```

## Deploy on Render

1. In Render, create a **Blueprint** or **Web Service** from the GitHub repository.
2. Render reads `render.yaml` and runs `npm ci` then `npm start`.
3. Set `DATABASE_URL` to the Aiven PostgreSQL service URI.
4. Optional but recommended: set `AIVEN_CA_CERT` to the Aiven project CA certificate, represented with literal `\n` line breaks.
5. Set `CORS_ORIGINS` to the dashboard origin, for example `https://your-dashboard.example.com`. Multiple origins are comma-separated.
6. Deploy and open `/api/health`.

Do not commit `.env`, database passwords, CA certificates, or Render deploy hooks.

## Connect the maintenance dashboard

Copy `public-dashboard-example/renderer.js` into the dashboard project, replace `YOUR-RENDER-SERVICE` with the assigned Render service name, and ensure the listed HTML element IDs exist.

## Important scheduling note

The current upcoming and overdue endpoints use `service_schedules.initial_due_date`. They do not yet calculate recurring next-due dates from the latest service record plus `period_days`. That calculation should be added after verifying the desired maintenance rule.
