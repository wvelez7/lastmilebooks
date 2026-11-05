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
| `EMAIL_TO` | Recommended | Extra comma-separated inboxes for new pickup requests. `thelastmilebooks@gmail.com` and `haylee@lastmilebooks.com` always receive them. |
| `EMAIL_FROM` | Recommended | Verified sender address (e.g. `pickups@lastmilebooks.com`). Must be on a domain verified in Resend. |
| `EMAIL_REPLY_TO` | Optional | Extra comma-separated inboxes for customer replies (`EMAIL_FROM` is send-only, so replies to it would bounce). `thelastmilebooks@gmail.com` and `haylee@lastmilebooks.com` always receive them. |
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

## Inventory sync (Whatnot + eBay)

When a book sells on one marketplace, its quantity drops here and the new
quantity is pushed to the other marketplace (at 0 the listing comes down).
Code lives in `server/inventory/`; the admin page is `/#/inventory` (enter `ADMIN_KEY`).

- Books are matched by **SKU**: use the same SKU on the Whatnot listing and as the eBay "Custom label", then click **Import & match by SKU**. Books without a SKU (e.g. $1 live-show stock) are ignored.
- Orders on both marketplaces are checked every `INVENTORY_POLL_SECONDS` (default 60). The first check starts from "now", so older orders are never replayed. Optional Whatnot webhooks (`POST /api/webhooks/whatnot`) make Whatnot sales near-instant.
- A failed update is logged on the admin page, retried every poll, and emailed to the team inboxes once.
- Cancelled orders are **not** relisted automatically; relist by hand.

Setup:

1. **Render disk**: `render.yaml` mounts a 1 GB disk at `/var/data` and sets `DATABASE_PATH=/var/data/data.db`. Without it the database is wiped on every deploy.
2. **Whatnot**: whatnot.com/dashboard/developer → Personal access tokens → new token with `read:orders`, `read:inventory`, `write:inventory`. Set it as `WHATNOT_API_TOKEN`.
3. **eBay**: developer.ebay.com → create a Production keyset (`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`), then User Tokens → add a RuName (`EBAY_RU_NAME`) whose "auth accepted URL" is `https://<site>/api/inventory/ebay/callback`. Then click **Connect eBay** on the admin page.

| Variable | Description |
| --- | --- |
| `ADMIN_KEY` | Password for the admin page and `GET /api/pickup-requests`. |
| `DATABASE_PATH` | SQLite file path (persistent disk on Render). |
| `WHATNOT_API_TOKEN` | Whatnot Seller API personal access token. |
| `WHATNOT_WEBHOOK_SECRET` | Optional. Webhook signing secret (`wn_wh_…`). |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` / `EBAY_RU_NAME` | eBay Production app keys and RuName. |
| `INVENTORY_POLL_SECONDS` | Optional. Order check interval, default 60. |

## Book scanner

Phone page at `/#/scan` (enter `ADMIN_KEY`; it's remembered on the device). Scan a barcode with the camera, or use a USB/Bluetooth scanner or the text box, to see the eBay price and estimated profit. Add it to the phone's home screen to use it like an app. The camera only works over `https://`.

- Uses the eBay connection from the inventory sync, so connect eBay first. It needs no extra setup.
- Every active listing is copied into the `ebay_listings` table every 15 minutes (or with **Refresh**). ISBNs need one eBay call per listing, so the first run takes a while on a big store. They're fetched up to 1,000 at a time, then re-checked weekly.
- Without eBay API access, upload Seller Hub's "All active listings" report on the **Inventory** tab. It replaces the list, and prices stay as they were in the file until the next upload. Reports don't include shipping, so enter what buyers pay when uploading.
- A scan matches the listing's ISBN (either length) or its Custom label. Books you don't have listed show the cheapest fixed-price US listings from other sellers instead.
- Profit = book price + shipping charged − eBay fees − postage and supplies − cost of the book. eBay's fee is charged on the total including shipping and the buyer's sales tax. Set the rates and your costs on the **Costs** tab; the calculation is in `shared/profit.ts`. Calculated-shipping listings assume the buyer's shipping equals your postage. Promoted Listings fees aren't included.

## Service area

Murrieta · Menifee · Temecula · surrounding Riverside County, CA.

## Contact

[thelastmilebooks@gmail.com](mailto:thelastmilebooks@gmail.com)
