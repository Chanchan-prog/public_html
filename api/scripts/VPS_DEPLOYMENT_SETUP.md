# VPS deployment setup (Apache + PHP + MySQL + cron)

This guide deploys the attendance system on a standard **Ubuntu VPS with Apache** so
everything that relies on `.htaccess` (API routing, directory protections,
HTTPS redirect, caching) and the **every-minute cron scheduler** works exactly
like your local XAMPP. It is the lowest-churn path from the cPanel layout that
the project already documents.

> Ready-made hosts with free/trial credits for this flow: **DigitalOcean
> ($200 / 60 days)**, **Oracle Cloud Always Free (free forever)**, **Vultr /
> Linode (smaller trial credits)**. Use 2 GB RAM / 2 vCPU or more.

---

## 0. Prerequisites

1. A fresh **Ubuntu 24.04** VPS (2 GB RAM minimum).
2. A **domain/subdomain** (e.g. `tams.example.com`) with an **A record pointing to
   the VPS IP address**. You need a domain for:
   - Let's Encrypt HTTPS (free certificate),
   - Web Push notifications (they require HTTPS),
   - the API's same-origin check.
   `https://tams.example.com/api` is the layout used below.
3. SSH access to the server as a sudo user.

> If you only have an IP address (no domain), you can install and test, but
> Let's Encrypt, Web Push, and notification features will **not** work.
> Get a domain first.

---

## 1. Provision and secure the server

```bash
# Update packages
sudo apt update && sudo apt -y upgrade

# Firewall: allow SSH, HTTP, HTTPS
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

---

## 2. Install the stack

Ubuntu 24.04 ships PHP 8.3, which satisfies the project's `php: ^8.2`
requirement (QR code, Web Push, and JWT packages all need 8.2+).

```bash
sudo apt install -y \
  apache2 \
  mariadb-server \
  php8.3 libapache2-mod-php8.3 php8.3-cli \
  php8.3-mysql php8.3-gd php8.3-curl php8.3-mbstring \
  php8.3-intl php8.3-xml php8.3-zip php8.3-bcmath \
  git unzip curl

# Enable the Apache modules the app's .htaccess files depend on
sudo a2enmod rewrite
sudo a2enmod headers
sudo systemctl restart apache2

# Install Composer globally
curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
composer --version
```

> - `php8.3-mysql` provides both `mysqli` and `pdo_mysql` (the app uses
>   `mysqli`).
> - `php8.3-gd` is needed to write PNG QR codes (`endroid/qr-code`).
> - `openssl`, `iconv`, `json`, `ctype`, `filter` are compiled into PHP and need
>   no extra package.

---

## 3. Deploy the application files

The app must be laid out exactly as its own production checklist describes:

```
/var/www/tams/
  index.php    # from front-end/
  .htaccess    # from front-end/
  public/      # from front-end/public/
  api/         # the complete api/ directory
  src/         # from front-end/src/ (loaded by the runtime JSX loader)
  scripts/     # from front-end/scripts/
```

```bash
sudo mkdir -p /var/www/tams
sudo chown "$USER":"$USER" /var/www/tams

# Option A: clone your repo, then assemble the layout
git clone <YOUR_REPO_URL> /tmp/app
cp -r /tmp/app/front-end/index.php   /var/www/tams/
cp -r /tmp/app/front-end/.htaccess   /var/www/tams/
cp -r /tmp/app/front-end/public      /var/www/tams/
cp -r /tmp/app/front-end/src         /var/www/tams/
cp -r /tmp/app/front-end/scripts     /var/www/tams/
cp -r /tmp/app/api                    /var/www/tams/api

# Option B: if your repo already tracks the merged "public_html" tree, copy it.
```

> `vendor/` is committed in this project (not gitignored), so PHP dependencies
> are already present. Still run `composer install` once so the **Web Push
> OpenSSL patch script** runs and versions are confirmed:

```bash
cd /var/www/tams/api
COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --no-interaction --prefer-dist
```

---

## 4. Set writable permissions (uploads, logs, cache)

On a VPS the disk persists across restarts (unlike some platforms), but the
Apache user (`www-data`) and the cron worker must be able to write runtime data.

```bash
sudo mkdir -p /var/www/tams/api/uploads /var/www/tams/api/logs /var/www/tams/api/cache

sudo chown -R www-data:www-data \
  /var/www/tams/api/uploads \
  /var/www/tams/api/logs \
  /var/www/tams/api/cache

# Directories 775, files 664 for those writable folders
sudo find /var/www/tams/api/uploads /var/www/tams/api/logs /var/www/tams/api/cache -type d -exec chmod 775 {} +
sudo find /var/www/tams/api/uploads /var/www/tams/api/logs /var/www/tams/api/cache -type f -exec chmod 664 {} +
```

---

## 5. Create the database

The app reads the connection from either `DB_*` environment variables or
`api/config/database.private.php`. Using the private file is simplest on Apache.

```bash
sudo mysql <<'SQL'
CREATE DATABASE IF NOT EXISTS tams CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'tams'@'localhost' IDENTIFIED BY 'REPLACE_WITH_A_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON tams.* TO 'tams'@'localhost';
CREATE USER IF NOT EXISTS 'tams'@'127.0.0.1' IDENTIFIED BY 'REPLACE_WITH_A_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON tams.* TO 'tams'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
```

Then configure the app:

```bash
cp /var/www/tams/api/config/database.private.php.example /var/www/tams/api/config/database.private.php
sudoedit /var/www/tams/api/config/database.private.php
```

Fill in:

```php
return [
    'host' => 'localhost',
    'port' => 3306,
    'name' => 'tams',
    'user' => 'tams',
    'pass' => 'REPLACE_WITH_A_STRONG_PASSWORD',
];
```

> Existing data? Import it: `mysql -u tams -p tams < your_dump.sql`

---

## 6. Configure email (SMTP)

```bash
cp /var/www/tams/api/config/private-mail.php.example /var/www/tams/api/config/private-mail.php
sudoedit /var/www/tams/api/config/private-mail.php
```

Fill in a real SMTP account (Gmail App Password, or the school's SMTP relay).
`smtp_secure` = `tls` (port 587) or `ssl` (port 465):

```php
return [
    'smtp_host'   => 'smtp.example.com',
    'smtp_port'   => 587,
    'smtp_secure' => 'tls',
    'smtp_user'   => 'notifications@example.com',
    'smtp_pass'   => 'REPLACE_WITH_SMTP_APP_PASSWORD',
    'from_email'  => 'notifications@example.com',
    'from_name'   => 'Teacher Attendance',
    'timeout'     => 15,
];
```

> Some VPS providers block outbound port 25, but 587/465 are normally allowed.
> If delivery fails, inspect `/var/www/tams/api/logs/php-errors.log`.

---

## 7. Web Push / security keys (VAPID)

Web Push needs a VAPID **public/private key pair** plus a reset secret. The
project reads `api/config/private-security.php` (gitignored) or the
`APP_RESET_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` env vars.

- **Keep existing browser subscriptions working:** copy your local
  `C:\xampp\htdocs\3D1.3xxsc\api\config\private-security.php` to the server so
  the **same VAPID pair** is used. Existing notification subscriptions only
  work if the VAPID keys match, so prefer this.
- **Start fresh:** generate a new pair. After rotation every user must open the
  site signed in once so the browser re-subscribes.

Create the file on the server:

```bash
sudoedit /var/www/tams/api/config/private-security.php
# content:
<?php
return [
  'reset_secret' => 'REPLACE_WITH_RANDOM_HEX',
  'vapid_public_key'  => 'YOUR_VAPID_PUBLIC_KEY',
  'vapid_private_key' => 'YOUR_VAPID_PRIVATE_KEY',
];
```

> Back these three private files up (`database.private.php`,
> `private-mail.php`, `private-security.php`): they are gitignored and will be
> lost if you delete the server.

---

## 8. API base URL (auto-derived)

The frontend used to hardcode `window.API_BASE` to the old cPanel domain
(`coc-studentinfo.net`). That value has been **removed from the repo** — the
frontend now **auto-derives the base from the page origin** in
`front-end/public/index.html` and `src/services/api.js`
(`origin + projectRoot + '/api'`). On the VPS no change is needed: the browser
will automatically call `https://tams.example.com/api` because that is the same
origin the page is served from (which is also what the API's same-origin check
requires).

If you ever need an explicit override (for example the API on a separate origin
that has been explicitly allowed), set `window.API_BASE` in the deployed
`public/index.html`.

---

## 9. Apache virtual host + .htaccess

Create a vhost. The app is designed to be served from the domain/subdomain root
so its `base href` and `API_BASE` logic work without a subfolder.

```bash
sudo nano /etc/apache2/sites-available/tams.conf
```

```apache
<VirtualHost *:80>
    ServerName tams.example.com
    DocumentRoot /var/www/tams

    DirectoryIndex index.php

    # The app's two .htaccess files MUST be honored (routing + protections)
    <Directory /var/www/tams>
        AllowOverride All
        Require all granted
        Options -Indexes +FollowSymLinks
    </Directory>

    ErrorLog  ${APACHE_LOG_DIR}/tams_error.log
    CustomLog ${APACHE_LOG_DIR}/tams_access.log combined
</VirtualHost>
```

Enable and restart:

```bash
sudo a2dissite 000-default
sudo a2ensite tams.conf
sudo apachectl configtest
sudo systemctl reload apache2
```

---

## 10. Enable HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache -d tams.example.com
```

Certbot obtains a free certificate and configures the redirect. The app's own
security headers and HTTPS detection take over from there (it already looks at
`X-Forwarded-Proto` and `HTTPS`).

Verify it works end-to-end while signed in.

---

## 11. Schedule the attendance cron (every minute)

The scheduler entry point is `api/scripts/cpanel-attendance-cron.php`. Add one
cron job so status transitions, attendance generation, and school-year sync run
every minute. First confirm it can connect and read/write its state:

```bash
# Run a safe check (does not modify attendance)
/usr/bin/php /var/www/tams/api/scripts/cpanel-attendance-cron.php --check
```

It should print JSON with `"ok": true`. Then install the cron job as **root**
(so it can always write the lock/state files):

```bash
sudo crontab -e
```

Add this line:

```cron
* * * * * /usr/bin/php /var/www/tams/api/scripts/cpanel-attendance-cron.php >/dev/null 2>&1
```

(If `which php` prints a different path, use that path instead.)

Wait ~6 minutes and confirm:

```bash
tail -f /var/www/tams/api/logs/academic-attendance-worker.log
```

You should see fresh timestamps, `AttendanceStatuses` entries every minute, and
the five-minute tasks (academic sync / record generation) at least once.

---

## 12. Final verification checklist

1. `https://tams.example.com` shows the login page.
2. Log in, browse a few pages, then open DevTools → Network to confirm all
   requests go to `https://tams.example.com/api/...` (200, not 403).
3. Scan a QR and confirm check-in / mid / out.
4. Send yourself a test notification (Web Push) — must work over HTTPS.
5. Trigger a password reset email — confirm SMTP delivery.
6. Upload an avatar and a profile/building file — confirm it appears and
   survives an `sudo systemctl restart apache2`.
7. Confirm `/api/uploads`, `/api/config`, and `/var/www/tams/api/vendor` are
   not reachable directly in the browser (should be 403).

---

## Appendix A — cPanel / shared hosting path (Hostinger etc.)

If you prefer not to manage a server, use a cPanel host (Hostinger, etc.). This
is what the project's existing `PRODUCTION_DEPLOYMENT_CHECKLIST.md` was written
for, so it deploys with **no build pipeline**:

1. In cPanel **MySQL Databases**, create the DB + user, grant full access, and
   put those values in `database.private.php` (`name`, `user`, `pass`).
2. Upload the merged tree to `public_html/tams/` (same layout as section 3).
3. Keep both `.htaccess` files. Ensure the host runs **PHP 8.2+** with
   `mysqli`, `gd`, `openssl`, `curl`, `mbstring`, `iconv`, `intl` enabled
   (cPanel: **Select PHP Version** → extensions).
4. Set the SMTP + VAPID private files (sections 6–7). Enable **HTTPS** (free
   Let's Encrypt in cPanel).
5. `API_BASE` is now auto-derived (section 8); no edit is needed unless you
   require an explicit override.
6. Add **one cron job, every minute** (section 11) — the project already ships
   these exact instructions in `CRON_WORKER_SETUP.md`.
7. Make `api/logs/`, `api/cache/`, `api/uploads/` writable by the cPanel account
   (the checklist says mode 755 dirs / 644 files are usually enough).

Caveats: budget shared plans may limit **CPU time** and sometimes restrict
**cron to ≥5 minutes** or a daily cap. Confirm the plan allows a per-minute cron
before paying; otherwise use the VPS path.

---

## Troubleshooting

- **`database_unavailable` in cron `--check`:** fix `database.private.php` and
  the MySQL grants, then re-run.
- **`cross_origin_request_denied` (403) in the browser:** the frontend is being
  served from a different origin than the API. `API_BASE` is auto-derived
  (section 8), so serve both from the same origin, or
   set `window.API_BASE` explicitly.
- **Web Push fails:** check HTTPS is on, VAPID keys match the ones used for the
  subscription, and `vendor/` exists with the patch applied. Re-enable
  notifications in the app (turn off/on) to re-subscribe.
- **Uploads disappear:** on a VPS that event-box is unlikely, but ensure
  `api/uploads` is owned/owned-writable by `www-data` and never on a temporary
  mount.
- **Order of the two `.htaccess` rewrites:** leave them unmodified; only adjust
  `AllowOverride`/docroot in the vhost.