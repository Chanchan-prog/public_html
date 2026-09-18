<?php

if (!function_exists('class_schedule_import_normalize_lookup')) {
    function class_schedule_import_normalize_lookup($value): string
    {
        return strtolower(trim((string)$value));
    }
}

if (!function_exists('class_schedule_import_room_label')) {
    function class_schedule_import_room_label(array $room): string
    {
        $parts = array_values(array_filter([
            trim((string)($room['building_name'] ?? '')),
            trim((string)($room['floor_name'] ?? '')),
            trim((string)($room['room_name'] ?? '')),
        ], static fn($part) => $part !== ''));
        return implode(' — ', $parts);
    }
}

if (!function_exists('class_schedule_import_build_room_lookup')) {
    function class_schedule_import_build_room_lookup(array $rooms): array
    {
        $lookup = [];
        foreach ($rooms as $room) {
            $roomNameKey = class_schedule_import_normalize_lookup($room['room_name'] ?? '');
            if ($roomNameKey !== '') $lookup[$roomNameKey][] = $room;

            $qualifiedKey = class_schedule_import_normalize_lookup(class_schedule_import_room_label($room));
            if ($qualifiedKey !== '') $lookup[$qualifiedKey] = [$room];
        }
        return $lookup;
    }
}

if (!function_exists('class_schedule_import_resolve_room')) {
    function class_schedule_import_resolve_room(array $lookup, $value): array
    {
        $matches = $lookup[class_schedule_import_normalize_lookup($value)] ?? [];
        if (count($matches) === 1) return ['status' => 'found', 'room' => $matches[0]];
        if (count($matches) > 1) return ['status' => 'ambiguous', 'room' => null];
        return ['status' => 'missing', 'room' => null];
    }
}

if (!function_exists('class_schedule_import_row_number')) {
    function class_schedule_import_row_number(int $zeroBasedIndex, bool $spreadsheetImport): int
    {
        return $zeroBasedIndex + ($spreadsheetImport ? 2 : 1);
    }
}

if (!function_exists('class_schedule_import_normalize_name')) {
    function class_schedule_import_normalize_name($value): string
    {
        return strtolower(trim((string)preg_replace('/\s+/u', ' ', (string)$value)));
    }
}

if (!function_exists('class_schedule_import_teacher_names_match')) {
    function class_schedule_import_teacher_names_match(array $teacher, $firstName, $lastName): array
    {
        return [
            'first_name' => class_schedule_import_normalize_name($firstName) !== ''
                && class_schedule_import_normalize_name($firstName) === class_schedule_import_normalize_name($teacher['first_name'] ?? ''),
            'last_name' => class_schedule_import_normalize_name($lastName) !== ''
                && class_schedule_import_normalize_name($lastName) === class_schedule_import_normalize_name($teacher['last_name'] ?? ''),
        ];
    }
}

if (!function_exists('class_schedule_import_skipped_count')) {
    function class_schedule_import_skipped_count(int $total, int $inserted): int
    {
        return max(0, $total - $inserted);
    }
}
