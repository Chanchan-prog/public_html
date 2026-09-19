const HTML_INPUT_ERROR = 'HTML or script content is not allowed in this field.';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const HTML_DELIMITER_PATTERN = /[<>]/;
const invalidStyleSnapshots = new WeakMap();
const INVALID_INLINE_STYLES = {
  'border-color': '#dc2626',
  color: '#dc2626',
  'caret-color': '#dc2626',
  'box-shadow': '0 0 0 3px rgba(220, 38, 38, 0.14)',
  'outline-color': '#dc2626',
};

export function sanitizeHtmlInput(value) {
  let text = String(value ?? '').replace(/\u0000/g, '');
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  text = text.replace(/<[^>]*>?/g, '');
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '');
  return text.trim();
}

export function hasUnsafeHtmlInput(value) {
  const text = String(value ?? '');
  return HTML_DELIMITER_PATTERN.test(text) || CONTROL_CHARACTER_PATTERN.test(text);
}

function isProtectedStructuredField(field) {
  if (!field || field.disabled || field.readOnly) return true;
  const tag = String(field.tagName || '').toLowerCase();
  if (tag === 'textarea' || field.isContentEditable) return false;
  if (tag !== 'input') return true;
  const type = String(field.type || 'text').toLowerCase();
  return !['text', 'email', 'search', 'tel', 'url', 'password'].includes(type);
}

function errorElementFor(field) {
  const existingId = field.getAttribute('data-html-input-error-id');
  if (existingId) {
    const existing = document.getElementById(existingId);
    if (existing) return existing;
  }
  const id = `html-input-error-${Math.random().toString(36).slice(2, 10)}`;
  const error = document.createElement('div');
  error.id = id;
  error.className = 'frontend-html-input-error';
  error.setAttribute('role', 'alert');
  error.textContent = HTML_INPUT_ERROR;
  error.style.setProperty('display', 'block', 'important');
  error.style.setProperty('width', '100%', 'important');
  error.style.setProperty('margin-top', '0.3rem', 'important');
  error.style.setProperty('color', '#dc2626', 'important');
  error.style.setProperty('font-size', '0.78rem', 'important');
  error.style.setProperty('font-weight', '600', 'important');
  field.setAttribute('data-html-input-error-id', id);
  field.insertAdjacentElement('afterend', error);
  return error;
}

function showHtmlInputError(field) {
  if (!invalidStyleSnapshots.has(field)) {
    const snapshot = {};
    Object.keys(INVALID_INLINE_STYLES).forEach((property) => {
      snapshot[property] = {
        value: field.style.getPropertyValue(property),
        priority: field.style.getPropertyPriority(property),
      };
    });
    invalidStyleSnapshots.set(field, snapshot);
  }
  Object.entries(INVALID_INLINE_STYLES).forEach(([property, value]) => {
    field.style.setProperty(property, value, 'important');
  });
  field.classList.add('frontend-html-input-invalid');
  field.setAttribute('aria-invalid', 'true');
  const error = errorElementFor(field);
  error.hidden = false;
  error.style.setProperty('display', 'block', 'important');
}

function clearHtmlInputError(field) {
  const snapshot = invalidStyleSnapshots.get(field);
  if (snapshot) {
    Object.entries(snapshot).forEach(([property, original]) => {
      if (original.value) field.style.setProperty(property, original.value, original.priority || '');
      else field.style.removeProperty(property);
    });
    invalidStyleSnapshots.delete(field);
  }
  field.classList.remove('frontend-html-input-invalid');
  field.removeAttribute('aria-invalid');
  const id = field.getAttribute('data-html-input-error-id');
  const error = id ? document.getElementById(id) : null;
  if (error) {
    error.hidden = true;
    error.style.setProperty('display', 'none', 'important');
  }
}

export function validateHtmlInputControl(field) {
  if (isProtectedStructuredField(field)) return true;
  const value = field?.isContentEditable ? field.textContent : field?.value;
  if (!hasUnsafeHtmlInput(value)) {
    clearHtmlInputError(field);
    return true;
  }
  showHtmlInputError(field);
  return false;
}

const SENSITIVE_OR_STRUCTURED_FIELD = /(?:secret|token|jwt|authorization|subscription|endpoint|p256dh|auth_key|private_key|public_key|module_permissions|permission_data|json|payload|metadata|avatar|image|file|base64)/i;

export function assertSafeHtmlInputPayload(payload, fieldName = '') {
  if (Array.isArray(payload)) {
    payload.forEach((value) => assertSafeHtmlInputPayload(value, fieldName));
    return payload;
  }
  if (payload && typeof payload === 'object') {
    Object.entries(payload).forEach(([key, value]) => assertSafeHtmlInputPayload(value, key));
    return payload;
  }
  if (typeof payload === 'string' && !SENSITIVE_OR_STRUCTURED_FIELD.test(String(fieldName || '')) && hasUnsafeHtmlInput(payload)) {
    const error = new Error(HTML_INPUT_ERROR);
    error.code = 'unsafe_html_input';
    error.field = fieldName;
    throw error;
  }
  return payload;
}

export function installHtmlInputValidation(root = document) {
  if (!root || root.__htmlInputValidationInstalled) return () => {};
  root.__htmlInputValidationInstalled = true;
  const handleInput = (event) => {
    const field = event.target;
    if (isProtectedStructuredField(field)) return;
    validateHtmlInputControl(field);
  };
  const handleInvalid = (event) => {
    const field = event.target;
    if (isProtectedStructuredField(field)) return;
    const value = field?.isContentEditable ? field.textContent : field?.value;
    if (!hasUnsafeHtmlInput(value)) return;
    event.preventDefault();
    showHtmlInputError(field);
  };

  const handleSubmit = (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const fields = Array.from(form.querySelectorAll('input, textarea, [contenteditable="true"]'));
    const invalidField = fields.find((field) => !validateHtmlInputControl(field));
    if (!invalidField) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showHtmlInputError(invalidField);
    invalidField.focus?.();
  };

  root.addEventListener('input', handleInput, true);
  root.addEventListener('invalid', handleInvalid, true);
  root.addEventListener('submit', handleSubmit, true);

  return () => {
    root.removeEventListener('input', handleInput, true);
    root.removeEventListener('invalid', handleInvalid, true);
    root.removeEventListener('submit', handleSubmit, true);
    delete root.__htmlInputValidationInstalled;
  };
}

export { HTML_INPUT_ERROR };
