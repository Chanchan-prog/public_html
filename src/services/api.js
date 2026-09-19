// Central API URL builder. Every frontend caller should append only an endpoint
// (for example "users" or "forgot-password") to this one base path.
import { assertSafeHtmlInputPayload } from '../utils/htmlInputValidation.js';

const getApiBase = () => {
    // Server-side fallback
    if (typeof window === 'undefined') return '../api';

    // Explicit override (dev tunnel or config)
    if (window.API_BASE) return String(window.API_BASE).replace(/\/+$|\s+/g, '');

    // Derive project root from pathname (first path segment), e.g. '/3D1.1'
    const origin = window.location.origin.replace(/\/+$/, '');
    const parts = window.location.pathname.split('/').filter(Boolean);
    // If site is being served from a top-level /public (dev tunnel), don't treat 'public' as the project folder
    let projectRoot = '';
    if (parts.length) {
      const first = String(parts[0]).toLowerCase();
      if (first !== 'public') {
        projectRoot = '/' + parts[0];
      }
    }
    return origin + projectRoot + '/api';
};

const apiUrl = (path = '') => {
  const base = getApiBase().replace(/\/+$/, '');
  const endpoint = String(path).replace(/^\/+/, '');
  return endpoint ? base + '/' + endpoint : base;
};

const getCsrfToken = () => {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)cdo_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
};

const UNEXPECTED_RESPONSE_MESSAGE = 'The server returned an unexpected response. Please try again.';
const NETWORK_ERROR_MESSAGE = 'Network request failed. Check your connection and try again.';

const looksLikeHtmlResponse = (value) => {
  const text = String(value || '').trimStart();
  return /^(?:<!doctype\s+html|<html|<head|<body|<script)\b/i.test(text);
};

const safeErrorMessage = (value, fallback) => {
  const message = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!message || message.length > 300 || looksLikeHtmlResponse(message) || /<\/?[a-z][^>]*>/i.test(message)) {
    return fallback;
  }
  return message;
};

const sanitizeStructuredErrorBody = (body, fallback) => {
  const sanitized = Object.assign({}, body);
  if (typeof sanitized.message === 'string') {
    sanitized.message = safeErrorMessage(sanitized.message, fallback);
  }
  if (typeof sanitized.error === 'string') {
    sanitized.error = safeErrorMessage(sanitized.error, 'request_failed');
  }
  return sanitized;
};

// Minimal API helper using fetch with 401 auto-logout
const apiFetch = async (path, opts = {}) => {
  // `returnMeta` is an opt-in escape hatch for callers that need response
  // headers/status (for example conditional GETs). Keep it out of fetch()
  // options so existing callers retain exactly the same return contract.
  const returnMeta = opts.returnMeta === true;
  const fetchOpts = Object.assign({}, opts);
  delete fetchOpts.returnMeta;
  const url = apiUrl(path);
  const headers = Object.assign({}, fetchOpts.headers || {});
  const lastActivityAt = localStorage.getItem('last_activity_at');
  if (lastActivityAt) headers['X-User-Activity-At'] = lastActivityAt;
  const method = String(fetchOpts.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  if (!headers['Content-Type'] && fetchOpts.body && !(fetchOpts.body instanceof FormData)) headers['Content-Type'] = 'application/json';

  try {
    console.debug('[apiFetch] Request', fetchOpts.method || 'GET', url);
    const res = await fetch(url, Object.assign({ credentials: 'include' }, fetchOpts, { headers }));

    // A conditional GET has no response body. It is successful for callers
    // that explicitly request metadata, even though Response.ok is false for
    // status 304.
    if (res.status === 304 && returnMeta) {
      return { data: null, status: 304, headers: res.headers };
    }

    // Read the response body as text once to avoid re-reading the stream.
    const resText = await res.text();

    if (!res.ok) {
      // handle 401 -> clear auth and redirect to login
      if (res.status === 401) {
        try {
          localStorage.removeItem('user');
          localStorage.removeItem('token');
          localStorage.removeItem('last_activity_at');
          localStorage.removeItem('session_meta');
        } catch (e) {}
        try { window.dispatchEvent(new CustomEvent('auth-session-invalidated')); } catch (e) {}
        window.location.hash = '#/login';
        const err = new Error('Unauthorized');
        err.status = 401;
        throw err;
      }

      // Preserve structured API errors, but never pass an HTML response (for
      // example a hosting/security challenge) through to the interface.
      let body = null;
      try { body = resText ? JSON.parse(resText) : null; } catch (e) { body = null; }
      const structuredBody = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
      const fallbackMessage = res.status >= 500
        ? 'The service is temporarily unavailable. Please try again.'
        : 'The request could not be completed. Please try again.';
      const sanitizedBody = structuredBody ? sanitizeStructuredErrorBody(structuredBody, fallbackMessage) : null;
      const message = sanitizedBody
        ? safeErrorMessage(sanitizedBody.message || sanitizedBody.error, fallbackMessage)
        : fallbackMessage;
      const err = new Error(message);
      err.status = res.status;
      err.code = sanitizedBody?.error || (looksLikeHtmlResponse(resText) ? 'unexpected_response' : 'request_failed');
      err.body = sanitizedBody || { error: err.code, message };
      if (!structuredBody && resText) {
        console.error('[apiFetch] Non-JSON error response', {
          url,
          status: res.status,
          contentType: res.headers.get('content-type') || 'unknown',
        });
      }
      throw err;
    }

    // For successful responses, attempt to parse JSON from the text
    try {
      const data = resText ? JSON.parse(resText) : null;
      return returnMeta ? { data, status: res.status, headers: res.headers } : data;
    } catch (parseErr) {
      console.error('[apiFetch] Unexpected response format', {
        url,
        status: res.status,
        contentType: res.headers.get('content-type') || 'unknown',
        appearsToBeHtml: looksLikeHtmlResponse(resText),
      });
      const e = new Error(UNEXPECTED_RESPONSE_MESSAGE);
      e.status = res.status;
      e.code = 'unexpected_response';
      e.body = { error: e.code, message: UNEXPECTED_RESPONSE_MESSAGE };
      throw e;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    // Preserve API errors (status/body) so callers can show real backend messages.
    const hasApiMeta = !!(err && (typeof err.status !== 'undefined' || typeof err.body !== 'undefined'));
    if (hasApiMeta) throw err;

    // Network or other unexpected errors
    console.error('[apiFetch] Network error', { url, method, error: err });
    const e = new Error(NETWORK_ERROR_MESSAGE);
    e.code = 'network_error';
    e.original = err;
    throw e;
  }
};

const apiGet = (path, opts = {}) => apiFetch(path, opts);
const apiPost = (path, payload) => {
  assertSafeHtmlInputPayload(payload);
  return apiFetch(path, { method: 'POST', body: JSON.stringify(payload) });
};
const apiPut = (path, payload) => {
  assertSafeHtmlInputPayload(payload);
  return apiFetch(path, { method: 'PUT', body: JSON.stringify(payload) });
};
const apiDelete = (path, payload) => {
  if (payload) assertSafeHtmlInputPayload(payload);
  return apiFetch(path, { method: 'DELETE', body: payload ? JSON.stringify(payload) : undefined });
};

// expose globals for legacy code that expects apiGet/apiPost
try { window.apiUrl = apiUrl; window.apiFetch = apiFetch; window.apiGet = apiGet; window.apiPost = apiPost; window.apiPut = apiPut; window.apiDelete = apiDelete; } catch(e) {}

// exports for module consumers
export { getApiBase, apiUrl, apiFetch, apiGet, apiPost, apiPut, apiDelete, getCsrfToken };
