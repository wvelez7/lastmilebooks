# Last Mile Books

Marketing site + book-donation pickup request form for Last Mile Books, serving Murrieta, Menifee, Temecula, and surrounding areas in Riverside County, CA.

## Stack

- **Frontend:** React + Vite + Tailwind CSS + shadcn/ui
- **Backend:** Express (Node) + Drizzle ORM + SQLite (`better-sqlite3`)
- **Email:** Pluggable transport — Resend or SendGrid (falls back to console log if no API key set)

Frontend and backend are served from a single Express process on one port.

## Local development

```bash
npm install
npm run dev
```

Opens on `http://localhost:5000`.

## Production build

```bash
npm run build
NODE_ENV=production node dist/index.cjs
```

The build outputs:
- `dist/public/` — static frontend
- `dist/index.cjs` — Express server bundle

## Environment variables

Set these in your hosting provider (Render, Railway, Fly, etc.):

| Variable | Required | Description |
| --- | --- | --- |
| `RESEND_API_KEY` | Recommended | Your [Resend](https://resend.com) API key. Without it, pickup requests are still saved to the database but no email is sent. |
| `EMAIL_TO` | Recommended | Inbox to receive new pickup requests. Defaults to `thelastmilebooks@gmail.com`. |
| `EMAIL_FROM` | Recommended | Verified sender address (e.g. `pickups@lastmilebooks.com`). Must be on a domain verified in Resend. |
| `PORT` | Optional | Server port. Defaults to `5000`. Render sets this automatically. |
| `NODE_ENV` | Required in prod | Set to `production`. |

## Deploying to Render

1. Push this repo to GitHub.
2. In [Render](https://render.com): **New** → **Web Service** → connect this repo.
3. Settings:
   - Build command: `npm install && npm run build`
   - Start command: `NODE_ENV=production node dist/index.cjs`
   - Environment: Node
4. Add the environment variables above.
5. Add a custom domain under **Settings → Custom Domains**. Render issues a free SSL cert.

A `render.yaml` is included for one-click "Blueprint" deploys.

## Pickup request endpoint

- `POST /api/pickup-requests` — public, accepts a JSON pickup request, validates with Zod, persists to SQLite, and sends an email.
- `GET /api/pickup-requests` — admin endpoint listing all requests (no auth — protect or remove before exposing publicly).

## Service area

Murrieta · Menifee · Temecula · surrounding Riverside County, CA.

## Contact

[thelastmilebooks@gmail.com](mailto:thelastmilebooks@gmail.com)
