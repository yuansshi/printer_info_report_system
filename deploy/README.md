# Remote deployment

The dashboard is scheduler-agnostic. A remote job runs one idempotent command:

```bash
python3 update_printer_dashboard.py --config /etc/printer-dashboard/dashboard_config.json
```

The included examples target a Linux host with systemd and Nginx. Adjust paths and service ownership to the target environment.

## Runtime layout

```text
/opt/printer-dashboard/            # application code
/etc/printer-dashboard/            # non-secret config and mail.env
/var/lib/printer-dashboard/        # durable history, daily XLSX files and manifests
/var/www/printer-dashboard/        # index.html, bootstrap.js, app.js, styles.css, data.js
```

The `printer-dashboard` service account needs read access to the IMAP credential file and mapping workbook, plus write access to `/var/lib/printer-dashboard` and `/var/www/printer-dashboard/data.js`. The Node.js runtime must be able to resolve `@oai/artifact-tool`, which generates the daily Excel workbooks.

## Install outline

1. Install Python 3.11+, Node.js, the project-provided `@oai/artifact-tool` runtime dependency and Nginx.
2. Copy the project to `/opt/printer-dashboard`.
3. Copy `dashboard/index.html`, `dashboard/bootstrap.js`, `dashboard/app.js` and `dashboard/styles.css` to `/var/www/printer-dashboard`.
4. Copy `deploy/dashboard_config.remote.json` to `/etc/printer-dashboard/dashboard_config.json`.
5. Put the mapping workbook in `/var/lib/printer-dashboard/` and the Sina IMAP settings in `/etc/printer-dashboard/mail.env` with mode `0600`.
6. Install the systemd service/timer and Nginx example, then run one manual backfill.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now printer-dashboard-update.timer
sudo systemctl start printer-dashboard-update.service
sudo systemctl status printer-dashboard-update.service
sudo systemctl list-timers printer-dashboard-update.timer
```

The Nginx example listens only on `127.0.0.1:8080`. Put authentication and TLS in the external reverse proxy before exposing it to users.

For containers or Kubernetes, invoke the same update command from a CronJob and mount persistent volumes at the history and web-output paths.

Daily audit workbooks are stored at `/var/lib/printer-dashboard/daily_reports/YYYY-MM-DD/`. Back up this directory together with `/var/lib/printer-dashboard/history/`. This project tracks synchronized snapshots of both directories by explicit policy; keep the repository access-controlled because those files contain customer and device data.
