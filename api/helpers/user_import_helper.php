<?php

if (!function_exists('user_import_normalize_key')) {
    function user_import_normalize_key($value) {
        return trim((string)preg_replace('/[^a-z0-9]+/', '_', strtolower(trim((string)$value))), '_');
    }
}

if (!function_exists('user_import_pick')) {
    function user_import_pick(array $row, array $allowedKeys) {
        foreach ($allowedKeys as $key) {
            if (array_key_exists($key, $row) && $row[$key] !== null && trim((string)$row[$key]) !== '') {
                return trim((string)$row[$key]);
            }
        }
        return '';
    }
}

if (!function_exists('user_import_add_lookup_candidate')) {
    function user_import_add_lookup_candidate(array &$lookup, $label, $id) {
        $key = strtolower(trim((string)$label));
        $id = (int)$id;
        if ($key === '' || $id <= 0) return;
        if (!isset($lookup[$key])) $lookup[$key] = [];
        if (!in_array($id, $lookup[$key], true)) $lookup[$key][] = $id;
    }
}

if (!function_exists('user_import_resolve_lookup')) {
    function user_import_resolve_lookup(array $lookup, $value) {
        $key = strtolower(trim((string)$value));
        $matches = $key !== '' && isset($lookup[$key]) ? array_values(array_unique(array_map('intval', $lookup[$key]))) : [];
        if (count($matches) === 1) return ['status' => 'resolved', 'id' => $matches[0]];
        if (count($matches) > 1) return ['status' => 'ambiguous', 'id' => null];
        return ['status' => 'not_found', 'id' => null];
    }
}

if (!function_exists('user_import_is_valid_contact')) {
    function user_import_is_valid_contact($value) {
        $contact = preg_replace('/\D+/', '', (string)$value);
        return $contact === '' || preg_match('/^09\d{9}$/', $contact) === 1;
    }
}

