# Production deployment checklist

The hosted site needs the frontend and API on the same HTTPS origin. For a
deployment at `https://example.com/tams`, the public directory should contain:

```text
public_html/tams/
  index.php             # from front-end/
  .htaccess             # from front-end/
  public/               # from front-end/public/
  api/                  # the complete api/ directory
```

The frontend then calls `https://example.com/tams/api/...` automatically. Do
not serve the frontend from a different domain unless `window.API_BASE` is set
and the API is explicitly configured for that origin.

## 1. Configure private values

Copy these examples on the server and replace their placeholders:

```text
api/config/database.private.php.example -> api/config/database.private.php
api/config/private-mail.php.example -> api/config/private-mail.php
```

The database user and database name normally have the cPanel account prefix,
for example `account_tams` and `account_appuser`; they are not XAMPP's `root`
account. Give that user full access to the selected database in **MySQL
Databases**.

`private-security.php` contains the VAPID pair used for Web Push. Keep the
existing production file during a normal code deployment. Do not overwrite it
with a file from another machine and do not create a new key pair for a routine
redeploy.

Use either these private files or the equivalent environment variables:

```text
DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS
MAIL_SMTP_HOST, MAIL_SMTP_PORT, MAIL_SMTP_SECURE
MAIL_SMTP_USER, MAIL_SMTP_PASS, MAIL_FROM_EMAIL, MAIL_FROM_NAME
VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
```

Set `MAIL_SMTP_SECURE` to `tls` for STARTTLS (usually port 587) or `ssl` for
implicit TLS (usually port 465). The configured From address should normally
be the same mailbox/domain that the SMTP provider permits.

## 2. Check the server before enabling cron

In cPanel Terminal, substitute the real account name and PHP path. Do not
silence output for this first check:

```bash
/usr/local/bin/php /home/CPANEL_USER/public_html/tams/api/scripts/cpanel-attendance-cron.php --check
```

It must return JSON with `"ok": true`. If it reports `database_unavailable`,
fix the production database file/user/grant first. If it cannot create a lock
or state file, make `api/logs/` writable by the cPanel account (normally
directory mode 755 and file mode 644 are sufficient).

## 3. Create exactly one cron job

In **cPanel > Cron Jobs**, schedule this once per minute:

```cron
* * * * * /usr/local/bin/php /home/CPANEL_USER/public_html/tams/api/scripts/cpanel-attendance-cron.php
```

After the first successful run, it may be silenced because the worker writes
its own log:

```bash
/usr/local/bin/php /home/CPANEL_USER/public_html/tams/api/scripts/cpanel-attendance-cron.php >/dev/null 2>&1
```

Wait six minutes and confirm that `api/logs/academic-attendance-worker.log`
has fresh timestamps, `AttendanceStatuses` entries every minute, and the
five-minute tasks at least once. One successful manual run is not proof that
the cron job is installed.

## 4. Restore and verify Web Push

Web Push requires HTTPS, the same VAPID public/private pair used when the
browser subscription was created, and the `api/vendor/` dependencies on the
server. After a VAPID rotation, each user must open the site once while signed
in; the frontend renews the browser subscription automatically. If it does
not, select **Enable** in the notification menu (or turn it off and on).

The backend now removes subscriptions that FCM rejects because of a VAPID
mismatch. That prevents one old browser subscription from continuing to fail
after it is detected.

## 5. Verify email delivery

Trigger a notification or password reset for a test user with a real email
address. If delivery fails, inspect `api/logs/php-errors.log`. The new SMTP
messages identify the failing stage, for example `connect`, `STARTTLS
handshake`, or `authentication`, without logging the password. A connection
failure means the host is blocking outbound SMTP or the host/port is wrong;
use the host's approved SMTP relay or ask hosting support to allow that port.

## Credential rotation

An SMTP app password was previously stored directly in `api/config/mail.php`.
Treat it as exposed: revoke/rotate it at the mail provider, configure the new
value only in `private-mail.php` or server environment variables, and do not
commit private configuration or runtime logs.
