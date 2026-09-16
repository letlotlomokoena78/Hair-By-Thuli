# Hair by Thuli Salon

This folder contains the salon prototype and a production-shaped API backend.

## Frontend

- `index.html`: responsive public site, client booking flow, admin workspace prototype.
- `prices.html`: public category-based price list.
- `PRIVACY.md`: starting privacy notice to review before launch.

When served by the Node server, the frontend uses the API for authentication, service loading, bookings, and comments. Opening the HTML directly still uses a local preview fallback and should not be used for real client data.

## Backend setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Set a strong `ADMIN_PASSWORD`; never use the example value.
4. Set `ADMIN_EMAIL`, `MAIL_FROM`, and `HAIRDRESSER_EMAIL`.
5. Set `ADMIN_USERNAME` for the hairdresser login alias, currently `Kekgo`.
6. Add SMTP values when automatic booking emails are required.
7. Run:

```powershell
npm install
npm start
```

Open `http://localhost:3000`.

## GitHub Pages

GitHub Pages can host the static salon frontend. Push the contents of this folder to a GitHub repository with the included `.github/workflows/pages.yml` workflow, then enable **Settings > Pages > GitHub Actions**. The workflow publishes `index.html` and `prices.html` automatically on pushes to `main`.

GitHub Pages cannot run `server.js`, SQLite, secure login sessions, or SMTP email. The Pages version therefore uses the local preview behavior. For live bookings and hairdresser administration, deploy the Node backend to a Node-capable host and configure the frontend API URL for that host.

Run the automated API checks with:

```powershell
npm test
```

## API

- `POST /api/auth/register` creates a client account.
- `POST /api/auth/login` starts an HttpOnly session.
- `POST /api/auth/logout` ends the session.
- `GET /api/auth/me` returns the current user.
- `PUT /api/admin/account` lets Thuli change the admin email and password after verifying the current password.
- `GET /api/services` returns enabled categories and services.
- `PUT /api/admin/services` updates the admin-managed category/service catalog without deleting records used by existing bookings.
- `GET /api/promotions` returns the client promotion.
- `PUT /api/admin/promotions` edits the client-only promotion.
- `GET /api/contact` returns public contact details.
- `PUT /api/admin/contact` lets the hairdresser update name, email, phone, and WhatsApp details.
- `POST /api/bookings` creates a client booking with a date and 30-minute time slot from 09:00 through 18:00, and triggers an email when SMTP is configured.
- `GET /api/bookings/mine` returns the signed-in client's bookings.
- `GET /api/bookings` returns all bookings for an admin.
- `PATCH /api/bookings/:id/status` updates a booking status for an admin.
- `GET /api/comments` returns approved comments.
- `POST /api/comments` submits a client comment for moderation.
- `GET /api/admin/comments` returns pending comments.
- `PATCH /api/admin/comments/:id` approves or rejects a comment.
- `GET /api/health` checks API/database availability.

Booking email delivery is tracked as `pending`, `sent`, or `failed` in the database. Configure SMTP to enable automatic delivery.

## Production checklist

- Deploy behind HTTPS.
- Use a managed database and encrypted backups instead of a local SQLite file.
- Set a real SMTP provider and verify the sender domain.
- Use the server-backed frontend mode at `http://localhost:3000`; direct-file preview intentionally remains local-only.
- Add monitoring, error tracking, backups, a privacy policy, and a data-retention/deletion workflow before launch.
- Review and customize `PRIVACY.md` for the salon's jurisdiction and publish it alongside the site.
- Keep the initial admin credentials in `.env`; log in as `Kekgo` or the configured admin email, then change them from the Admin login panel in the hairdresser workspace.
- Do not place secrets in HTML or commit `.env`.
