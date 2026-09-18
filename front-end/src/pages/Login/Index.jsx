import React from 'react';
import { AuthContext } from "../../context/AuthContext.jsx";
import { apiUrl } from '../../services/api.js';
import { hasUnsafeHtmlInput } from '../../utils/htmlInputValidation.js';

const INSTITUTIONAL_EMAIL_PATTERN = /^[^\s@]+@phinmaed\.com$/i;

export default function LoginPage() {
  const { login } = React.useContext(AuthContext);
  const [loading, setLoading] = React.useState(false);

  const [form, setForm] = React.useState({ email: '', password: '' });
  const [credentialsInvalid, setCredentialsInvalid] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);
  const [lockSecondsLeft, setLockSecondsLeft] = React.useState(0);
  const lockTimerRef = React.useRef(null);
  
  // Captcha state
  const [captchaA, setCaptchaA] = React.useState(0);
  const [captchaB, setCaptchaB] = React.useState(0);
  const [captchaInput, setCaptchaInput] = React.useState('');
  const [captchaCorrect, setCaptchaCorrect] = React.useState(null); // null = no answer yet, true/false = correctness
  const captchaRef = React.useRef(null);

  React.useLayoutEffect(() => {
    try { document.body.classList.add('login-fullpage'); } catch (e) { }
    return () => {
      try { document.body.classList.remove('login-fullpage'); } catch (e) { }
    };
  }, []);

  const generateCaptcha = (focus = false) => {
    const a = Math.floor(Math.random() * 10) + 1;
    const b = Math.floor(Math.random() * 10) + 1;
    setCaptchaA(a);
    setCaptchaB(b);
    setCaptchaInput('');
    setCaptchaCorrect(null);
    if (focus) setTimeout(() => captchaRef.current?.focus?.(), 60);
  };

  React.useEffect(() => {
    generateCaptcha();
    // Restore existing lock countdown from localStorage
    try {
      const raw = window.localStorage.getItem('login_lock_until');
      if (raw) {
        const until = parseInt(raw, 10);
        if (!Number.isNaN(until)) {
          const now = Math.floor(Date.now() / 1000);
          const remaining = until - now;
          if (remaining > 0) startLockCountdown(remaining);
        }
      }
    } catch (e) { }

    return () => {
      if (lockTimerRef.current) clearInterval(lockTimerRef.current);
    };
  }, []);

  const startLockCountdown = (seconds) => {
    if (lockTimerRef.current) clearInterval(lockTimerRef.current);
    setLockSecondsLeft(seconds);
    try { window.localStorage.setItem('login_lock_until', String(Math.floor(Date.now() / 1000) + seconds)); } catch (e) {}
    lockTimerRef.current = setInterval(() => {
      setLockSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(lockTimerRef.current);
          lockTimerRef.current = null;
          try { window.localStorage.removeItem('login_lock_until'); } catch (e) {}
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleChange = (e) => {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    if (credentialsInvalid) setCredentialsInvalid(false);
  };
  
  const handleCaptchaChange = (e) => {
    // Only allow numbers
    const val = e.target.value.replace(/[^0-9]/g, '');
    setCaptchaInput(val);
    const expected = captchaA + captchaB;
    if (val === '') {
      setCaptchaCorrect(null);
    } else {
      setCaptchaCorrect(String(expected) === String(val));
    }
  };

  const doLogin = async (e) => {
    e && e.preventDefault();
    
    // Validate identifier (email or school ID)
    const identifier = (form.email || '').trim();
    if (!identifier) {
      try {
        await Swal.fire({
          icon: 'error',
          title: 'Missing Login ID',
          text: 'Enter your email or school ID number.',
          confirmButtonColor: '#d33'
        });
      } catch (e) {}
      return;
    }
    if (hasUnsafeHtmlInput(identifier)) return;
    if (hasUnsafeHtmlInput(form.password)) return;

    // School IDs remain valid login identifiers. If the user enters an email,
    // provide immediate feedback before sending it to the server.
    if (identifier.includes('@') && !INSTITUTIONAL_EMAIL_PATTERN.test(identifier)) {
      try {
        await Swal.fire({
          icon: 'error',
          title: 'Invalid Email Format',
          text: 'Enter a valid @phinmaed.com email address or use your school ID number.',
          confirmButtonColor: '#d33'
        });
      } catch (e) {}
      return;
    }

    // Validate Captcha
    const expected = captchaA + captchaB;
    if (String(expected) !== String(captchaInput)) {
      try { await Swal.fire({ icon: 'error', title: 'Incorrect Captcha', text: 'Please solve the math problem correctly.', confirmButtonColor: '#d33' }); } catch (e) { }
      generateCaptcha(true);
      return;
    }

    try {
      setLoading(true);
      const loginUrl = apiUrl('login');
      const res = await fetch(loginUrl, { 
        method: 'POST', 
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ email: form.email, password: form.password }) 
      });
      
      const dataText = await res.text();
      let data = null;
      try { data = dataText ? JSON.parse(dataText) : null; } catch (e) { }

      if (!res.ok) { 
        // Account locked (too many failed attempts)
        if (res.status === 429 && data && data.error === 'account_locked') {
          const secs = Number(data.remaining_seconds) || 30;
          setCredentialsInvalid(true);
          await Swal.fire({
            icon: 'error',
            title: 'Too Many Login Attempts',
            text: `Sign-in is temporarily unavailable due to repeated failed attempts. Please try again in ${secs} seconds.`,
            confirmButtonColor: '#d33'
          });
          startLockCountdown(secs);
          throw new Error('account_locked');
        }

        // Account inactive/archived
        if (res.status === 403 && data && data.error === 'account_inactive') {
          await Swal.fire({ icon: 'error', title: 'Account Inactive', text: data.message || 'Account is inactive. Contact administrator.', confirmButtonColor: '#d33' });
          throw new Error('account_inactive');
        }

        // Invalid credentials with remaining attempts info
        if (res.status === 401 && data && typeof data.remaining_attempts === 'number') {
          setCredentialsInvalid(true);
          await Swal.fire({
            icon: 'error',
            title: 'Invalid Credentials',
            text: 'Invalid email/ID number or password.',
            confirmButtonColor: '#d33'
          });
          throw new Error('invalid_credentials');
        }

        // Generic error
        const msg = data?.message || data?.error || 'Login failed';
        await Swal.fire({ icon: 'error', title: 'Login Error', text: msg, confirmButtonColor: '#d33' });
        throw new Error(msg);
      }
      
      if (!data || !data.user || !data.session) throw new Error('Invalid login response');
      
      login(data.user, data.session);

      if (Number(data.user?.is_first_login || 0) === 1) {
        // Keep the authenticated but restricted session on the login screen.
        // AppShell opens the mandatory password setup modal here, and the
        // router permits /home only after that setup succeeds.
        window.location.hash = '#/login';
      } else {
        try {
          const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 3000, timerProgressBar: true });
          Toast.fire({ icon: 'success', title: 'Signed in successfully' });
        } catch (e) { }
        window.location.hash = '#/home';
      }
    } catch (err) {
      try {
        const message = String(err?.message || '').trim();
        const alreadyHandled = message === 'invalid_credentials' || message === 'account_locked' || message === 'account_inactive';
        if (!alreadyHandled) {
          await Swal.fire({ title: 'Error', text: message || 'An error occurred during login.', confirmButtonColor: '#d33' });
        }
      } catch (e) { }
      generateCaptcha();
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (ev) => {
    ev && ev.preventDefault();
    try {
      setLoading(true);
      let email = '';
      let otpRequested = false;
      let otpRequestedAtMs = 0;
      const otpTtlSeconds = 2 * 60;
      const resendCooldownSeconds = 30;
      let resendAvailableAtMs = 0;
      let resendInFlight = false;
      const getOtpRemainingSeconds = () => Math.max(
        0,
        otpRequestedAtMs > 0 ? otpTtlSeconds - Math.floor((Date.now() - otpRequestedAtMs) / 1000) : 0
      );
      const getResendRemainingSeconds = () => Math.max(
        0,
        Math.ceil((resendAvailableAtMs - Date.now()) / 1000)
      );
      let otpCountdownInterval = null;
      let resendButtonEl = null;
      let resendClickHandler = null;
      let sendCodeButtonEl = null;
      let sendCodeClickHandler = null;
      let emailInputEl = null;
      let emailKeydownHandler = null;

      const { value: formValues } = await Swal.fire({
        title: 'Reset Password',
        html: `
          <div class="reset-password-modal">
            <div id="swal-reset-email-stage">
              <div class="reset-modal-intro">
                <span class="reset-modal-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M4 5.5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Zm0 2v.3l8 5.1 8-5.1v-.3H4Zm16 9v-6.3l-7.46 4.76a1 1 0 0 1-1.08 0L4 10.2v6.3h16Z"/></svg>
                </span>
                <div>
                  <div class="reset-stage-title">Verify your account</div>
                  <p class="reset-subtitle">Enter the email address registered to your account.</p>
                </div>
              </div>
              <label class="reset-label" for="swal-reset-email">Email address</label>
              <input id="swal-reset-email" type="email" class="swal2-input reset-input" placeholder="email@example.com" autocomplete="email">
              <div class="reset-security-note">If this email is registered, a verification code will be sent.</div>
              <button type="button" id="swal-send-reset-code" class="reset-resend-btn">Send verification code</button>
              <div id="swal-email-hint" class="reset-resend-hint" aria-live="polite"></div>
            </div>
            <div id="swal-reset-code-stage" style="display:none">
              <div class="reset-modal-intro reset-modal-intro-code">
                <span class="reset-modal-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M17 8h-1V6a4 4 0 1 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2Zm-7-2a2 2 0 1 1 4 0v2h-4V6Zm7 13H7v-9h10v9Zm-5-2a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/></svg>
                </span>
                <div>
                  <div class="reset-stage-title">Create a new password</div>
                  <p class="reset-subtitle">Enter the code sent to <span id="swal-reset-target-email" class="reset-email"></span>.</p>
                </div>
              </div>
              <div class="reset-code-tools">
                <div id="swal-otp-timer" class="reset-timer" aria-live="polite"></div>
                <div class="reset-resend-row">
                  <button type="button" id="swal-resend-code" class="reset-resend-btn">Resend code</button>
                  <span id="swal-resend-hint" class="reset-resend-hint"></span>
                </div>
              </div>
              <label class="reset-label" for="swal-otp">Verification code</label>
              <input id="swal-otp" class="swal2-input reset-input reset-otp" placeholder="6-digit code" maxlength="6" pattern="[0-9]*" inputmode="numeric">
              <label class="reset-label" for="swal-password">New password</label>
              <input id="swal-password" type="password" class="swal2-input reset-input" placeholder="Create a strong password">
              <label class="reset-label" for="swal-confirm">Confirm new password</label>
              <input id="swal-confirm" type="password" class="swal2-input reset-input" placeholder="Re-enter your new password">
              <div class="reset-req-card">
                <div class="reset-req-title">Password requirements</div>
                <div class="reset-req-list">
                  <div id="pw-req-length" class="reset-req-item">At least 8 characters</div>
                  <div id="pw-req-letter" class="reset-req-item">Contains a letter (A-Z or a-z)</div>
                  <div id="pw-req-number" class="reset-req-item">Contains a number (0-9)</div>
                  <div id="pw-req-special" class="reset-req-item">Contains a special character</div>
                  <div id="pw-req-match" class="reset-req-item">Password confirmation matches</div>
                </div>
              </div>
            </div>
          </div>
        `,
        showCancelButton: true,
        confirmButtonText: 'Set new password',
        customClass: {
          popup: 'login-reset-modal-popup',
          title: 'login-reset-modal-title',
          confirmButton: 'login-reset-modal-confirm',
          cancelButton: 'login-reset-modal-cancel',
          validationMessage: 'login-reset-modal-validation'
        },
        buttonsStyling: false,
        focusConfirm: false,
        didOpen: () => {
          const emailStageEl = document.getElementById('swal-reset-email-stage');
          const codeStageEl = document.getElementById('swal-reset-code-stage');
          emailInputEl = document.getElementById('swal-reset-email');
          sendCodeButtonEl = document.getElementById('swal-send-reset-code');
          const emailHintEl = document.getElementById('swal-email-hint');
          const targetEmailEl = document.getElementById('swal-reset-target-email');
          const timerEl = document.getElementById('swal-otp-timer');
          resendButtonEl = document.getElementById('swal-resend-code');
          const resendHintEl = document.getElementById('swal-resend-hint');
          const otpInput = document.getElementById('swal-otp');
          const pwdInput = document.getElementById('swal-password');
          const confirmInput = document.getElementById('swal-confirm');
          const reqLength = document.getElementById('pw-req-length');
          const reqLetter = document.getElementById('pw-req-letter');
          const reqNumber = document.getElementById('pw-req-number');
          const reqSpecial = document.getElementById('pw-req-special');
          const reqMatch = document.getElementById('pw-req-match');
          const confirmButton = Swal.getConfirmButton ? Swal.getConfirmButton() : null;
          if (confirmButton) {
            confirmButton.style.display = 'none';
            confirmButton.disabled = true;
          }
          const setEmailHint = (text, type = 'neutral') => {
            if (!emailHintEl) return;
            emailHintEl.textContent = text || '';
            emailHintEl.classList.remove('is-success', 'is-error');
            if (type === 'success') emailHintEl.classList.add('is-success');
            if (type === 'error') emailHintEl.classList.add('is-error');
          };
          const setResendHint = (text, type = 'neutral') => {
            if (!resendHintEl) return;
            resendHintEl.textContent = text || '';
            resendHintEl.classList.remove('is-success', 'is-error');
            if (type === 'success') resendHintEl.classList.add('is-success');
            if (type === 'error') resendHintEl.classList.add('is-error');
          };

          const updateOtpTimer = () => {
            const remaining = getOtpRemainingSeconds();
            const mm = Math.floor(remaining / 60);
            const ss = remaining % 60;
            if (timerEl) {
              if (remaining <= 0) {
                timerEl.textContent = 'Code expired. Request a new code.';
                timerEl.classList.add('is-expired');
              } else {
                timerEl.textContent = `Code expires in ${mm}:${String(ss).padStart(2, '0')}`;
                timerEl.classList.remove('is-expired');
              }
            }
            if (confirmButton) confirmButton.disabled = remaining <= 0;
          };
          const updateResendUi = () => {
            const remaining = getResendRemainingSeconds();
            if (sendCodeButtonEl) {
              sendCodeButtonEl.disabled = resendInFlight || remaining > 0;
              sendCodeButtonEl.textContent = resendInFlight ? 'Sending...' : (remaining > 0 ? `Wait ${remaining}s` : 'Send verification code');
            }
            if (resendButtonEl) {
              resendButtonEl.disabled = resendInFlight || remaining > 0;
              resendButtonEl.textContent = resendInFlight ? 'Sending...' : 'Resend code';
            }
            if (!resendInFlight) {
              if (remaining > 0) {
                if (!resendHintEl || !resendHintEl.classList.contains('is-error')) {
                  setResendHint(`Resend available in ${remaining}s`);
                }
              } else if (
                !resendHintEl ||
                (
                  !resendHintEl.classList.contains('is-success') &&
                  !resendHintEl.classList.contains('is-error')
                )
              ) {
                setResendHint("Didn't get the code? You can resend now.");
              }
            }
          };
          sendCodeClickHandler = async () => {
            if (resendInFlight || getResendRemainingSeconds() > 0) return;
            const candidate = String(emailInputEl?.value || '').trim();
            if (hasUnsafeHtmlInput(candidate)) {
              setEmailHint('HTML or script content is not allowed in this field.', 'error');
              emailInputEl?.focus();
              return;
            }
            if (!candidate || !emailInputEl?.checkValidity()) {
              setEmailHint('Enter a valid email address.', 'error');
              emailInputEl?.focus();
              return;
            }

            resendInFlight = true;
            if (sendCodeButtonEl) {
              sendCodeButtonEl.disabled = true;
              sendCodeButtonEl.textContent = 'Sending...';
            }
            setEmailHint('Sending a verification code...');
            try {
              const response = await fetch(apiUrl('forgot-password'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: candidate })
              });
              const responseData = await response.json().catch(() => ({}));
              if (response.status === 429 && responseData.retry_after) {
                resendAvailableAtMs = Date.now() + Number(responseData.retry_after) * 1000;
              }
              if (!response.ok) throw new Error(responseData.message || responseData.error || 'Failed to send verification code');

              email = candidate;
              otpRequested = true;
              otpRequestedAtMs = Date.now();
              resendAvailableAtMs = Date.now() + (Number(responseData.retry_after) || resendCooldownSeconds) * 1000;
              if (targetEmailEl) targetEmailEl.textContent = email;
              if (emailStageEl) emailStageEl.style.display = 'none';
              if (codeStageEl) codeStageEl.style.display = '';
              if (confirmButton) confirmButton.style.display = '';
              setResendHint('If the email is registered, the verification code has been sent.', 'success');
              updateOtpTimer();
              updateResendUi();
              otpInput?.focus();
            } catch (error) {
              setEmailHint(error?.message || 'Failed to send verification code. Please try again.', 'error');
            } finally {
              resendInFlight = false;
              if (sendCodeButtonEl) {
                sendCodeButtonEl.disabled = false;
                sendCodeButtonEl.textContent = 'Send verification code';
              }
              updateResendUi();
            }
          };
          resendClickHandler = async () => {
            if (resendInFlight || getResendRemainingSeconds() > 0) return;
            resendInFlight = true;
            updateResendUi();
            setResendHint('Sending a new code...');
            try {
              const resendRes = await fetch(apiUrl('forgot-password'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
              });
              const resendData = await resendRes.json().catch(() => ({}));
              if (resendRes.status === 429 && resendData.retry_after) {
                resendAvailableAtMs = Date.now() + Number(resendData.retry_after) * 1000;
              }
              if (!resendRes.ok) throw new Error(resendData.message || resendData.error || 'Failed to resend code');
              otpRequestedAtMs = Date.now();
              resendAvailableAtMs = Date.now() + (Number(resendData.retry_after) || resendCooldownSeconds) * 1000;
              setResendHint('If the email is registered, a new code has been sent.', 'success');
              updateOtpTimer();
            } catch (error) {
              setResendHint(error?.message || 'Failed to resend code. Please try again.', 'error');
            } finally {
              resendInFlight = false;
              updateResendUi();
            }
          };

          updateOtpTimer();
          updateResendUi();
          otpCountdownInterval = setInterval(() => {
            updateOtpTimer();
            updateResendUi();
          }, 1000);
          if (resendButtonEl && resendClickHandler) {
            resendButtonEl.addEventListener('click', resendClickHandler);
          }
          if (sendCodeButtonEl && sendCodeClickHandler) {
            sendCodeButtonEl.addEventListener('click', sendCodeClickHandler);
          }
          emailKeydownHandler = (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            sendCodeClickHandler?.();
          };
          emailInputEl?.addEventListener('keydown', emailKeydownHandler);
          emailInputEl?.focus();

          if (otpInput) {
            otpInput.addEventListener('input', () => {
              otpInput.value = (otpInput.value || '').replace(/[^0-9]/g, '').slice(0, 6);
            });
          }

          if (pwdInput && confirmInput && reqLength && reqLetter && reqNumber && reqSpecial && reqMatch) {
            const apply = (el, ok) => {
              if (!el) return;
              el.classList.toggle('is-valid', !!ok);
              el.classList.toggle('is-invalid', !ok);
            };
            const updateReqs = () => {
              const val = pwdInput.value || '';
              const confirmVal = confirmInput.value || '';
              const okLength = val.length >= 8;
              const okLetter = /[A-Za-z]/.test(val);
              const okNumber = /[0-9]/.test(val);
              const okSpecial = /[^A-Za-z0-9]/.test(val);
              const okMatch = val.length > 0 && confirmVal.length > 0 && val === confirmVal;
              apply(reqLength, okLength);
              apply(reqLetter, okLetter);
              apply(reqNumber, okNumber);
              apply(reqSpecial, okSpecial);
              apply(reqMatch, okMatch);
            };
            pwdInput.addEventListener('input', updateReqs);
            confirmInput.addEventListener('input', updateReqs);
            updateReqs();
          }
        },
        willClose: () => {
          if (otpCountdownInterval) {
            clearInterval(otpCountdownInterval);
            otpCountdownInterval = null;
          }
          if (resendButtonEl && resendClickHandler) {
            resendButtonEl.removeEventListener('click', resendClickHandler);
          }
          if (sendCodeButtonEl && sendCodeClickHandler) {
            sendCodeButtonEl.removeEventListener('click', sendCodeClickHandler);
          }
          if (emailInputEl && emailKeydownHandler) {
            emailInputEl.removeEventListener('keydown', emailKeydownHandler);
          }
          resendButtonEl = null;
          resendClickHandler = null;
          sendCodeButtonEl = null;
          sendCodeClickHandler = null;
          emailInputEl = null;
          emailKeydownHandler = null;
        },
        preConfirm: () => {
          if (!otpRequested) {
            Swal.showValidationMessage('Send a verification code before setting a new password.');
            return null;
          }
          if (resendInFlight) {
            Swal.showValidationMessage('Please wait while the new code is being sent.');
            return null;
          }
          if (getOtpRemainingSeconds() <= 0) {
            Swal.showValidationMessage('Code expired. Please request a new code.');
            return null;
          }
          const otp = document.getElementById('swal-otp')?.value?.trim() || '';
          const pwd = document.getElementById('swal-password')?.value || '';
          const confirm = document.getElementById('swal-confirm')?.value || '';
          if (otp.length !== 6) { Swal.showValidationMessage('Enter the 6-digit code from your email'); return null; }
          if (hasUnsafeHtmlInput(pwd) || hasUnsafeHtmlInput(confirm)) return null;
          const okLength = pwd.length >= 8;
          const okLetter = /[A-Za-z]/.test(pwd);
          const okNumber = /[0-9]/.test(pwd);
          const okSpecial = /[^A-Za-z0-9]/.test(pwd);
          if (!(okLength && okLetter && okNumber && okSpecial)) {
            Swal.showValidationMessage('Password must be at least 8 characters and meet all the requirements below.');
            return null;
          }
          if (pwd !== confirm) { Swal.showValidationMessage('Passwords do not match'); return null; }
          return { email, otp, new_password: pwd };
        }
      });
      if (formValues) {
        const res2 = await fetch(apiUrl('reset-password'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formValues)
        });
        const data2 = await res2.json().catch(() => ({}));
        if (!res2.ok) throw new Error(data2.message || data2.error || 'Reset failed');
        await Swal.fire({ icon: 'success', title: 'Password reset', text: 'You can sign in with your new password.' });
      }
    } catch (err) {
      await Swal.fire({ icon: 'error', title: 'Error', text: err.message, confirmButtonColor: '#d33' });
    } finally {
      setLoading(false);
    }
  };

  const trimmedIdentifier = String(form.email || '').trim();
  const identifierHasUnsafeHtml = hasUnsafeHtmlInput(trimmedIdentifier);
  const emailFormatInvalid = !identifierHasUnsafeHtml && trimmedIdentifier.includes('@') && !INSTITUTIONAL_EMAIL_PATTERN.test(trimmedIdentifier);

  return (
    <div className="container-fluid p-0 position-relative login-page-shell" style={{ minHeight: '100vh', overflowX: 'hidden' }}>
      <div className="row g-0 vh-100 login-main-row">
        
        {/* Left Side: School Logo */}
        <div className="col-lg-6 d-flex flex-column justify-content-center align-items-center bg-transparent login-left-column" style={{ zIndex: 2 }}>
          <div className="text-center p-4 login-hero-panel login-logo-center mx-auto">
            {/* Main COC Seal */}
            <img src="cdoc-logo.webp?v=lossless-20260911" alt="COC Seal" className="img-fluid mb-3 login-seal" style={{ maxWidth: '280px' }} />            
            <h2 className="fw-bold text-dark mt-2" style={{ fontFamily: 'Times New Roman, serif', letterSpacing: '0.5px' }}>
              Cagayan De Oro College
            </h2>
            <p className="text-dark small px-3 mt-2" style={{ maxWidth: '400px', margin: '0 auto', fontSize: '0.9rem' }}>
              Max Suniel St. Carmen, Cagayan de Oro City, Misamis Oriental, Philippines 9000
            </p>
          </div>
        </div>

        {/* Right Side: Login Form */}
        <div className="col-lg-6 d-flex flex-column justify-content-center align-items-center position-relative" style={{ zIndex: 2 }}>
          
          <div className="w-100 login-form-panel" style={{ maxWidth: '450px', padding: '20px' }}>
            
            {/* Phinma Logo above the card */}
            <div className="d-flex align-items-center mb-4">
               {/* Adjust src to match your actual file for the Phinma globe logo */}
               <img
                 src="logo.png"
                 alt="Phinma Education"
                 style={{ height: '100px', width: 'auto', backgroundColor: 'transparent' }}
               />
               <div className="ms-3">
                 <h4 className="mb-0 fw-bold text-dark" style={{ letterSpacing: '0.5px' }}>PHINMA EDUCATION</h4>
                 <p className="mb-0 text-muted" style={{ fontSize: '0.8rem', letterSpacing: '1px' }}>MAKING LIVES BETTER THROUGH EDUCATION</p>
               </div>
            </div>

            {/* Login Card */}
            <div className="card shadow border-0" style={{ borderRadius: '12px', backgroundColor: '#fff' }}>
              <div className="card-body p-4 p-md-5">
                <h2 className="mb-4 fw-bold text-dark">Sign In</h2>
                
                <form onSubmit={doLogin}>
                  {/* Username (Email or ID) */}
                  <div className="mb-4">
                    <label className="form-label fw-bold text-dark">Email or ID Number</label>
                    <input 
                      name="email" 
                      value={form.email} 
                      onChange={handleChange} 
                      type="text" 
                      className={`form-control login-input ${(credentialsInvalid || identifierHasUnsafeHtml || emailFormatInvalid) ? 'is-invalid border-danger' : ''}`}
                      placeholder="Enter email or ID number" 
                      aria-invalid={credentialsInvalid || identifierHasUnsafeHtml || emailFormatInvalid}
                      required 
                    />
                    {emailFormatInvalid && (
                      <div className="invalid-feedback">
                        Enter a valid @phinmaed.com email address or use your school ID number.
                      </div>
                    )}
                  </div>

                  {/* Password */}
                  <div className="mb-4 position-relative">
                    <label className="form-label fw-bold text-dark">Password</label>
                    <input 
                      name="password" 
                      value={form.password} 
                      onChange={handleChange} 
                      type={showPassword ? "text" : "password"} 
                      className={`form-control login-input ${credentialsInvalid ? 'is-invalid border-danger' : ''}`}
                      placeholder="Enter Password" 
                      required 
                    />
                    <button 
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="btn position-absolute p-0 border-0"
                      style={{ right: '10px', bottom: '8px', color: '#6c757d' }}
                    >
                      <i className={`bi ${showPassword ? 'bi-eye' : 'bi-eye-slash'}`}></i>
                    </button>
                  </div>

                  {/* Captcha */}
                  <div className="mb-4">
                    <div className="d-flex align-items-center justify-content-between">
                      <div className="d-flex align-items-center gap-2">
                         <div className="captcha-box">{captchaA}</div>
                         <span className="fw-bold fs-5">+</span>
                         <div className="captcha-box">{captchaB}</div>
                         <span className="fw-bold fs-5">=</span>
                      </div>
                      <div className="d-flex align-items-center gap-2">
                        <input 
                          ref={captchaRef}
                          value={captchaInput}
                          onChange={handleCaptchaChange}
                          type="text" 
                          className="form-control captcha-input text-center"
                          maxLength={3}
                          required
                        />
                        <button 
                          type="button" 
                          onClick={() => generateCaptcha(true)}
                          className="btn btn-light btn-sm rounded-circle shadow-sm"
                          style={{ width: '32px', height: '32px' }}
                        >
                          <i className="bi bi-arrow-clockwise"></i>
                        </button>
                      </div>
                    </div>
                    {captchaCorrect !== null && (
                      <div className="mt-1 text-end">
                        <small className={captchaCorrect ? "text-success" : "text-danger"}>
                          {captchaCorrect ? "Captcha answer is correct." : "Captcha answer is incorrect."}
                        </small>
                      </div>
                    )}
                  </div>

                  {/* Submit Button */}
                  <div className="d-grid mb-3">
                    <button type="submit" className="btn btn-primary py-2 fw-bold" disabled={loading || lockSecondsLeft > 0} style={{ background: '#0d6efd', borderColor: '#0d6efd' }}>
                      {lockSecondsLeft > 0 ? `Locked (${lockSecondsLeft}s)` : (loading ? 'Signing In...' : 'Sign In')}
                    </button>
                  </div>
                  {lockSecondsLeft > 0 && (
                    <div className="text-center mb-2">
                      <small className="text-danger">
                        Too many failed attempts. Please wait {lockSecondsLeft} second{lockSecondsLeft !== 1 ? 's' : ''} before trying again.
                      </small>
                    </div>
                  )}

                  {/* Forgot Password */}
                  <div className="text-center">
                    <a href="#" onClick={handleForgot} className="text-decoration-none text-primary fw-bold small">
                      Forgot Password
                    </a>
                  </div>

                </form>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
