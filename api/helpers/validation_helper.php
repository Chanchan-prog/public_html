<?php

/**
 * Validate the institution's official email format:
 * four letters, a dot, one or more letters, then .coc@phinmaed.com.
 * Example: jeca.parajes.coc@phinmaed.com
 */
function validateEmailFormat($email) {
    $normalized = strtolower(trim((string)$email));
    return preg_match('/^[a-z]{4}\.[a-z]+\.coc@phinmaed\.com$/i', $normalized) === 1;
}

/**
 * Convert user-entered plain text to a safe value for storage.
 *
 * This intentionally removes script/style blocks and HTML tags instead of
 * HTML-encoding the value. Output contexts must still use htmlspecialchars()
 * (or React's normal text rendering) when displaying stored values.
 */
function sanitizeHtmlInput($value) {
    if (!is_scalar($value) && $value !== null) {
        return '';
    }

    $text = (string)($value ?? '');
    $text = str_replace("\0", '', $text);
    $text = preg_replace('#<(script|style)\b[^>]*>.*?</\1\s*>#is', '', $text) ?? '';
    $text = strip_tags($text);
    $text = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $text) ?? '';

    return trim($text);
}

/**
 * Detect HTML delimiters and unsafe control bytes without changing the value.
 * Use this for passwords, which must be validated or rejected but never
 * sanitized, trimmed, or otherwise transformed.
 */
function containsUnsafeHtmlInput($value) {
    if (!is_scalar($value) && $value !== null) return true;
    $text = (string)($value ?? '');
    return preg_match('/[<>]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', $text) === 1;
}

/**
 * Sanitize only fields that represent human-readable plain text.
 * Structured and security-sensitive values (passwords, tokens, dates, JSON,
 * coordinates, files, and push-subscription keys) are deliberately excluded.
 */
function sanitizeRelevantTextInputs($input, $fieldName = '') {
    if (is_array($input)) {
        $clean = [];
        foreach ($input as $key => $value) {
            $clean[$key] = sanitizeRelevantTextInputs($value, is_string($key) ? $key : $fieldName);
        }
        return $clean;
    }

    if (!is_string($input)) {
        return $input;
    }

    $field = strtolower(trim((string)$fieldName));
    if ($field === '') {
        return $input;
    }

    $sensitiveOrStructured = '/(?:password|passwd|secret|token|jwt|authorization|subscription|endpoint|p256dh|auth_key|private_key|public_key|module_permissions|permission_data|json|payload|metadata|avatar|image|file|base64)/i';
    if (preg_match($sensitiveOrStructured, $field)) {
        return $input;
    }

    $plainTextField = '/(?:^|_)(?:name|title|description|remark|remarks|reason|message|note|notes|address|designation|department|program|subject|section|room|building|floor|content|label|category|purpose|details|action|field|status|type|code)$/i';
    return preg_match($plainTextField, $field) ? sanitizeHtmlInput($input) : $input;
}
