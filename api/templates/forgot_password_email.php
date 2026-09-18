<?php
// api/templates/forgot_password_email.php
// Variables: $firstName, $lastName, $email, $otp
$displayName = trim($lastName . ', ' . $firstName) ?: 'User';
$safeEmail = htmlspecialchars($email ?? '', ENT_QUOTES, 'UTF-8');
$safeOtp = htmlspecialchars($otp ?? '', ENT_QUOTES, 'UTF-8');
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Forget Password</title>
</head>
<body style="margin: 0; padding: 20px; font-family: Arial, sans-serif; background-color: #ffffff;">
  <div style="max-width: 600px; margin: 0 auto;">
    <h1 style="color:rgb(0, 151, 35); font-size: 22px; font-weight: bold; text-align: center; margin-bottom: 20px;">Forget Password !!!</h1>
    <p style="color: #000000; font-size: 14px; line-height: 1.5; margin-bottom: 8px;">Dear <em><?php echo htmlspecialchars($displayName, ENT_QUOTES, 'UTF-8'); ?></em>,</p>
    <p style="color: #000000; font-size: 14px; line-height: 1.5; margin-bottom: 20px;">We received your request to set your password.</p>
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
    <div style="background-color: #e8f4ff; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <p style="color: #000000; font-size: 14px; line-height: 1.5; margin: 0 0 12px 0;">
        Your new one-time OTP for
        <a href="mailto:<?php echo $safeEmail; ?>" style="color: #0066cc; text-decoration: underline;"><?php echo $safeEmail; ?></a>
        Account is
      </p>
      <p style="font-size: 36px; font-weight: bold; letter-spacing: 4px; color:rgb(0, 88, 7); margin: 4px 0 0 0; text-align: center; font-family: 'Times New Roman', Georgia, serif;">
        <?php echo $safeOtp; ?>
      </p>
      <p style="color: #444; font-size: 13px; margin: 12px 0 0 0; text-align: center;">
        This code expires in 2 minutes.
      </p>
    </div>
    <p style="color: #666; font-size: 12px; margin-top: 24px;">If you did not request this, please ignore this email.</p>
  </div>
</body>
</html>
