# Password reset and private Web Push settings

Run once for each new deployment:

```sh
php api/scripts/init-private-security.php
```

The initializer creates `api/config/private-security.php` without printing secrets. It does not overwrite an existing file. That file is ignored by Git and blocked by the server's config-directory HTTP rule. Keep it private and back it up securely. On hosting without CLI access, generate it locally in a separate deployment copy and upload it through the hosting control panel. Do not reuse one installation's keys for a different deployment.

Environment overrides: `APP_RESET_SECRET` (at least 32 characters), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a real contact mailto address for production). Set both VAPID keys together. Do not rotate the reset secret during an active reset unless you intend to invalidate the pending code.

## Enforced limits

- Resend: one request per account every 30 seconds, including unknown accounts.
- Reset-email requests: at most 10 per IP per 15 minutes.
- Verification requests: at most 30 per account and 60 per IP per 15 minutes.
- Each code expires after two minutes and is invalid after five wrong guesses.
- A successful password reset consumes its code atomically with the password update and increments the account's token version to invalidate old sessions.
- Codes are stored as account-bound HMAC-SHA256 verifiers using a separate private secret, not readable six-digit codes. Existing legacy plaintext codes are retired when the new schema is initialized.
- IP limits use server-provided REMOTE_ADDR, never arbitrary forwarded headers. Users behind the same proxy/NAT share that allowance. Configure a trusted real-IP mechanism at the web server if necessary; do not trust arbitrary request headers in PHP.

## Push rotation

The embedded fallback key has been removed and this installation has a new pair. Signed-in browsers with notification permission compare their subscription key with the server key. When different, they renew the subscription on the next sync. If browser renewal fails, disable and re-enable notifications. Devices that have not returned may miss pushes until renewal.

## Verification

PHP lint and frontend compilation passed. Tests in an isolated disposable database covered cooldown expiry, five failed guesses, code replacement, expiry, replay prevention, rollback, account binding, and concurrent resend limits. Mocked browser tests covered unchanged and rotated subscription keys. The installed Web Push library validated the generated keys, and HTTP access to the private configuration returned 403.

No real password-reset emails or push notifications were sent during testing. Verify email receipt/reset with a test account and push delivery in a signed-in browser before public deployment. Existing user passwords and business records were not changed; pending legacy reset codes were invalidated.
