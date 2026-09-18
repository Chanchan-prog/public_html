<?php
/** @var string $firstName */
/** @var string $lastName */
/** @var string $username */
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Account Created</title>
</head>
<body style="margin:0;padding:0;background:#f6f8fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f8fb;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
          <tr>
            <td style="background:#1f9257;color:#ffffff;padding:16px 20px;font-size:18px;font-weight:700;">
              Account Successfully Created
            </td>
          </tr>
          <tr>
            <td style="padding:20px;line-height:1.6;font-size:15px;">
              <p style="margin:0 0 12px;">
                Dear <strong><?= htmlspecialchars(trim(($lastName ?? '') . ', ' . ($firstName ?? '')), ENT_QUOTES, 'UTF-8') ?></strong>,
              </p>
              <p style="margin:0 0 12px;">Good day.</p>
              <p style="margin:0 0 14px;">
                We are pleased to inform you that your account has been successfully created. You may now log in to the system using your registered credentials and begin accessing the available features and services.
              </p>

              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 14px;padding:12px;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb;">
                <tr>
                  <td style="padding:2px 0;font-size:14px;">
                    <strong>Username:</strong> <?= htmlspecialchars((string)($username ?? ''), ENT_QUOTES, 'UTF-8') ?>
                  </td>
                </tr>
                <tr>
                  <td style="padding:2px 0;font-size:14px;">
                    <strong>Password:</strong> (default: ID number)
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 12px;">
                If you encounter any issues while accessing your account or require further assistance, please feel free to contact our support team.
              </p>
              <p style="margin:0 0 12px;">Thank you, and welcome to our system.</p>
              <p style="margin:0;">
                Sincerely,<br />
                <strong>System Administrator</strong>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
