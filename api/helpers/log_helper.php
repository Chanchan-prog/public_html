<?php

/**
 * Resolve the originating client address consistently for localhost,
 * Apache reverse proxies, and Visual Studio/dev-tunnel forwarding.
 */
function get_client_ip_address() {
    $candidates = [];

    if (!empty($_SERVER['HTTP_CF_CONNECTING_IP'])) {
        $candidates[] = trim((string)$_SERVER['HTTP_CF_CONNECTING_IP']);
    }
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        foreach (explode(',', (string)$_SERVER['HTTP_X_FORWARDED_FOR']) as $forwardedIp) {
            $candidates[] = trim($forwardedIp);
        }
    }
    if (!empty($_SERVER['HTTP_X_REAL_IP'])) {
        $candidates[] = trim((string)$_SERVER['HTTP_X_REAL_IP']);
    }
    if (!empty($_SERVER['REMOTE_ADDR'])) {
        $candidates[] = trim((string)$_SERVER['REMOTE_ADDR']);
    }

    foreach ($candidates as $candidate) {
        if ($candidate !== '' && filter_var($candidate, FILTER_VALIDATE_IP)) {
            return substr($candidate, 0, 45);
        }
    }

    return 'UNKNOWN';
}

function format_ip_address_for_display($ip) {
    $value = trim((string)$ip);
    if ($value === '::1') return '127.0.0.1';
    return $value !== '' ? $value : '-';
}

function is_public_ipv4_address($ip) {
    return filter_var(
        trim((string)$ip),
        FILTER_VALIDATE_IP,
        FILTER_FLAG_IPV4 | FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
    ) !== false;
}

function ensure_ip_geolocation_cache_table($mysqli) {
    static $ensured = false;
    if ($ensured) return true;
    $ensured = (bool)$mysqli->query("CREATE TABLE IF NOT EXISTS tbl_ip_geolocation_cache (
        ip_address VARCHAR(45) NOT NULL,
        city VARCHAR(120) NULL,
        region_name VARCHAR(160) NULL,
        country_name VARCHAR(160) NULL,
        provider VARCHAR(200) NULL,
        lookup_status VARCHAR(30) NOT NULL DEFAULT 'unavailable',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (ip_address),
        KEY idx_ip_geo_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    return $ensured;
}

/**
 * Resolve approximate public IPv4 network information for audit display.
 * Successful results are cached for 30 days; failed lookups are retried after
 * one day. Local, private, reserved, and IPv6 addresses are never submitted.
 */
function get_public_ipv4_network_information($mysqli, $ip) {
    static $requestCache = [];
    $sourceIp = format_ip_address_for_display($ip);
    $empty = [
        'source_ip' => $sourceIp,
        'public_ipv4' => '',
        'approximate_location' => 'Location unavailable',
        'network_provider' => '',
        'network_status' => 'unavailable',
        'network_information' => 'Location unavailable',
    ];

    if (!is_public_ipv4_address($sourceIp)) return $empty;
    if (isset($requestCache[$sourceIp])) return $requestCache[$sourceIp];

    if (!ensure_ip_geolocation_cache_table($mysqli)) {
        $empty['public_ipv4'] = $sourceIp;
        return $requestCache[$sourceIp] = $empty;
    }

    $cached = null;
    $stmt = $mysqli->prepare('SELECT city, region_name, country_name, provider, lookup_status, updated_at FROM tbl_ip_geolocation_cache WHERE ip_address = ? LIMIT 1');
    if ($stmt) {
        $stmt->bind_param('s', $sourceIp);
        $stmt->execute();
        $cached = $stmt->get_result()->fetch_assoc();
        $stmt->close();
    }

    $cacheSeconds = (($cached['lookup_status'] ?? '') === 'success') ? 30 * 86400 : 86400;
    $cacheFresh = $cached && strtotime((string)$cached['updated_at']) >= time() - $cacheSeconds;
    $resolved = $cached;

    if (!$cacheFresh && function_exists('curl_init')) {
        $url = 'https://ipwho.is/' . rawurlencode($sourceIp);
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_TIMEOUT => 4,
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
            CURLOPT_USERAGENT => '3D-School-Audit/1.0',
        ]);
        $body = curl_exec($curl);
        $statusCode = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
        curl_close($curl);
        $payload = is_string($body) ? json_decode($body, true) : null;

        if ($statusCode === 200 && is_array($payload) && !empty($payload['success']) && ($payload['type'] ?? '') === 'IPv4') {
            $connection = is_array($payload['connection'] ?? null) ? $payload['connection'] : [];
            $resolved = [
                'city' => trim((string)($payload['city'] ?? '')),
                'region_name' => trim((string)($payload['region'] ?? '')),
                'country_name' => trim((string)($payload['country'] ?? '')),
                'provider' => trim((string)($connection['isp'] ?? $connection['org'] ?? '')),
                'lookup_status' => 'success',
                'updated_at' => date('Y-m-d H:i:s'),
            ];
        } else {
            $resolved = [
                'city' => '', 'region_name' => '', 'country_name' => '', 'provider' => '',
                'lookup_status' => 'failed', 'updated_at' => date('Y-m-d H:i:s'),
            ];
        }

        $save = $mysqli->prepare("INSERT INTO tbl_ip_geolocation_cache
            (ip_address, city, region_name, country_name, provider, lookup_status, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE city=VALUES(city), region_name=VALUES(region_name),
                country_name=VALUES(country_name), provider=VALUES(provider),
                lookup_status=VALUES(lookup_status), updated_at=NOW()");
        if ($save) {
            $save->bind_param(
                'ssssss',
                $sourceIp,
                $resolved['city'],
                $resolved['region_name'],
                $resolved['country_name'],
                $resolved['provider'],
                $resolved['lookup_status']
            );
            $save->execute();
            $save->close();
        }
    }

    $result = $empty;
    $result['public_ipv4'] = $sourceIp;
    if (($resolved['lookup_status'] ?? '') === 'success') {
        $locationParts = array_values(array_unique(array_filter([
            trim((string)($resolved['city'] ?? '')),
            trim((string)($resolved['region_name'] ?? '')),
            trim((string)($resolved['country_name'] ?? '')),
        ])));
        $result['approximate_location'] = $locationParts ? implode(', ', $locationParts) : 'Location unavailable';
        $result['network_provider'] = trim((string)($resolved['provider'] ?? ''));
        $result['network_status'] = 'public';
        $result['network_information'] = $sourceIp . ' | ' . $result['approximate_location'];
        if ($result['network_provider'] !== '') $result['network_information'] .= ' | ' . $result['network_provider'];
    }

    return $requestCache[$sourceIp] = $result;
}

function log_format_time_for_details($value) {
    $raw = trim((string)$value);
    if ($raw === '') return '';
    $timestamp = strtotime($raw);
    return $timestamp === false ? $raw : date('g:i A', $timestamp);
}

function log_format_date_for_details($value) {
    $raw = trim((string)$value);
    if ($raw === '') return '';
    $timestamp = strtotime($raw);
    return $timestamp === false ? $raw : date('F j, Y', $timestamp);
}

function log_room_name_for_details($mysqli, $roomId) {
    static $cache = [];
    $roomId = (int)$roomId;
    if ($roomId <= 0) return '';
    if (array_key_exists($roomId, $cache)) return $cache[$roomId];
    $cache[$roomId] = '';
    $stmt = $mysqli->prepare('SELECT room_name FROM tbl_rooms WHERE room_id = ? LIMIT 1');
    if (!$stmt) return '';
    $stmt->bind_param('i', $roomId);
    if ($stmt->execute()) {
        $row = $stmt->get_result()->fetch_assoc();
        $cache[$roomId] = trim((string)($row['room_name'] ?? ''));
    }
    $stmt->close();
    return $cache[$roomId];
}

function log_schedule_description($mysqli, $scheduleId) {
    static $cache = [];
    $scheduleId = (int)$scheduleId;
    if ($scheduleId <= 0) return 'the selected class schedule';
    if (array_key_exists($scheduleId, $cache)) return $cache[$scheduleId];

    $description = 'the selected class schedule';
    $sql = "SELECT CONCAT_WS(' ', u.first_name, u.last_name) AS teacher_name,
                   s.subject_code, s.subject_name, sec.section_name, r.room_name,
                   cs.day_of_week, cs.start_time, cs.end_time
            FROM tbl_class_schedules cs
            LEFT JOIN tbl_users u ON u.user_id = cs.user_id
            LEFT JOIN tbl_subject s ON s.subject_id = cs.subject_id
            LEFT JOIN tbl_sections sec ON sec.section_id = cs.section_id
            LEFT JOIN tbl_rooms r ON r.room_id = cs.room_id
            WHERE cs.schedule_id = ? LIMIT 1";
    $stmt = $mysqli->prepare($sql);
    if ($stmt) {
        $stmt->bind_param('i', $scheduleId);
        if ($stmt->execute()) {
            $row = $stmt->get_result()->fetch_assoc();
            if ($row) {
                $subject = trim((string)($row['subject_code'] ?? $row['subject_name'] ?? ''));
                $section = trim((string)($row['section_name'] ?? ''));
                $teacher = trim((string)($row['teacher_name'] ?? ''));
                $room = trim((string)($row['room_name'] ?? ''));
                $day = trim((string)($row['day_of_week'] ?? ''));
                $start = log_format_time_for_details($row['start_time'] ?? '');
                $end = log_format_time_for_details($row['end_time'] ?? '');
                $className = implode(' / ', array_filter([$subject, $section]));
                $parts = [];
                if ($className !== '') $parts[] = $className;
                if ($teacher !== '') $parts[] = 'taught by ' . $teacher;
                if ($room !== '') $parts[] = 'in ' . $room;
                if ($day !== '') $parts[] = 'on ' . ucfirst(strtolower($day));
                if ($start !== '' || $end !== '') $parts[] = trim($start . ($end !== '' ? '–' . $end : ''));
                if ($parts) $description = implode(' ', $parts);
            }
        }
        $stmt->close();
    }
    $cache[$scheduleId] = $description;
    return $description;
}

function log_attendance_description($mysqli, $attendanceId) {
    static $cache = [];
    $attendanceId = (int)$attendanceId;
    if ($attendanceId <= 0) return 'the selected attendance record';
    if (array_key_exists($attendanceId, $cache)) return $cache[$attendanceId];

    $description = 'the selected attendance record';
    $sql = "SELECT ar.date, ar.schedule_id,
                   CONCAT_WS(' ', u.first_name, u.last_name) AS teacher_name,
                   s.subject_code, s.subject_name, sec.section_name,
                   COALESCE(ar_room.room_name, schedule_room.room_name) AS room_name,
                   cs.start_time, cs.end_time
            FROM tbl_attendance_records ar
            LEFT JOIN tbl_users u ON u.user_id = ar.user_id
            LEFT JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
            LEFT JOIN tbl_subject s ON s.subject_id = cs.subject_id
            LEFT JOIN tbl_sections sec ON sec.section_id = cs.section_id
            LEFT JOIN tbl_rooms ar_room ON ar_room.room_id = ar.room_id
            LEFT JOIN tbl_rooms schedule_room ON schedule_room.room_id = cs.room_id
            WHERE ar.attendance_id = ? LIMIT 1";
    $stmt = $mysqli->prepare($sql);
    if ($stmt) {
        $stmt->bind_param('i', $attendanceId);
        if ($stmt->execute()) {
            $row = $stmt->get_result()->fetch_assoc();
            if ($row) {
                $teacher = trim((string)($row['teacher_name'] ?? ''));
                $subject = trim((string)($row['subject_code'] ?? $row['subject_name'] ?? ''));
                $section = trim((string)($row['section_name'] ?? ''));
                $room = trim((string)($row['room_name'] ?? ''));
                $date = log_format_date_for_details($row['date'] ?? '');
                $start = log_format_time_for_details($row['start_time'] ?? '');
                $end = log_format_time_for_details($row['end_time'] ?? '');
                $className = implode(' / ', array_filter([$subject, $section]));
                $parts = [];
                if ($teacher !== '') $parts[] = $teacher;
                if ($className !== '') $parts[] = 'for ' . $className;
                if ($room !== '') $parts[] = 'in ' . $room;
                if ($date !== '') $parts[] = 'on ' . $date;
                if ($start !== '' || $end !== '') $parts[] = trim($start . ($end !== '' ? '–' . $end : ''));
                if ($parts) $description = implode(' ', $parts);
            }
        }
        $stmt->close();
    }
    $cache[$attendanceId] = $description;
    return $description;
}

/** Convert technical audit text into a concise, user-facing description. */
function log_professionalize_details($mysqli, $action, $details) {
    $action = strtolower(trim((string)$action));
    $details = trim((string)$details);
    if ($details === '') return 'System activity completed.';

    $decoded = json_decode($details, true);
    if (is_array($decoded) && isset($decoded['event']) && strpos((string)$decoded['event'], 'class_schedule_edit') === 0) {
        $scheduleDescription = log_schedule_description($mysqli, (int)($decoded['schedule_id'] ?? 0));
        if ($action === 'approve_schedule_edit_request') $lead = 'Approved the schedule edit request for ';
        elseif ($action === 'reject_schedule_edit_request') $lead = 'Rejected the schedule edit request for ';
        else $lead = 'Updated the class schedule for ';
        $message = $lead . $scheduleDescription;
        $decisionNote = trim((string)($decoded['decision_note'] ?? ''));
        if ($decisionNote !== '') $message .= '. Decision note: ' . $decisionNote;
        return rtrim($message, '.') . '.';
    }

    if (preg_match('/attendance_id\s*=\s*(\d+)/i', $details, $match)) {
        $context = log_attendance_description($mysqli, (int)$match[1]);
        if ($action === 'create_attendance_edit_request') return 'Submitted an attendance edit request for ' . $context . '.';
        if ($action === 'approve_attendance_edit_request') return 'Approved the attendance edit request for ' . $context . '.';
        if ($action === 'reject_attendance_edit_request') return 'Rejected the attendance edit request for ' . $context . '.';
        $details = preg_replace('/attendance_id\s*=\s*\d+/i', $context, $details);
    }

    if (preg_match('/schedule_id\s*=\s*(\d+)/i', $details, $match)) {
        $context = log_schedule_description($mysqli, (int)$match[1]);
        if ($action === 'create_schedule_edit_request') return 'Submitted a schedule edit request for ' . $context . '.';
        if ($action === 'approve_schedule_edit_request') return 'Approved the schedule edit request for ' . $context . '.';
        if ($action === 'reject_schedule_edit_request') return 'Rejected the schedule edit request for ' . $context . '.';
        $details = preg_replace('/schedule_id\s*=\s*\d+/i', $context, $details);
    }

    if ($action === 'create_schedule' && preg_match('/room\s+(\d+)/i', $details, $match)) {
        $roomName = log_room_name_for_details($mysqli, (int)$match[1]);
        $details = preg_replace('/room\s+\d+/i', $roomName !== '' ? "room '{$roomName}'" : 'the selected room', $details, 1);
        if (preg_match('/on\s+([a-z]+)\s+(\d{1,2}:\d{2}(?::\d{2})?)-(\d{1,2}:\d{2}(?::\d{2})?)/i', $details, $timeMatch)) {
            $friendlySchedule = 'on ' . ucfirst(strtolower($timeMatch[1])) . ', '
                . log_format_time_for_details($timeMatch[2]) . '–'
                . log_format_time_for_details($timeMatch[3]);
            $details = str_replace($timeMatch[0], $friendlySchedule, $details);
        }
    }

    $details = preg_replace('/attendance edit request\s*#\d+/i', 'attendance edit request', $details);
    $details = preg_replace('/schedule edit request\s*#\d+/i', 'schedule edit request', $details);
    $details = preg_replace('/\bArchived school year ID\s*\d+\b/i', 'Archived the selected school year', $details);
    $details = preg_replace('/\bUpdated dates for Semester ID\s*\d+\b/i', 'Updated dates for the selected semester', $details);
    $details = preg_replace('/\s*\(ID\s*\d+\)/i', '', $details);
    $details = preg_replace('/\bDeleted offering ID\s*\d+\b/i', 'Deleted the selected academic offering', $details);
    $details = preg_replace('/\buser ID\s*\d+\b/i', 'the selected user account', $details);
    $details = preg_replace('/\bUser ID\s*\d+\b/', 'the selected user account', $details);
    $details = preg_replace('/Department Admin scope for department\s+\d+/i', 'Department Admin scope for the assigned department', $details);
    $details = preg_replace('/\bDeleted schedule ID\s*\d+\b/i', 'Deleted the selected class schedule', $details);
    $details = preg_replace('/\s+#\d+\b/', '', $details);
    $details = preg_replace('/\s{2,}/', ' ', trim($details));
    return rtrim($details, '.') . '.';
}

/**
 * Logs a system action to the database.
 * * @param mysqli $mysqli Database connection
 * @param int $user_id The ID of the user performing the action (MUST exist in tbl_users)
 * @param string $action Short action name (e.g., 'create_department')
 * @param string $details Readable details
 */
function log_system_action($mysqli, $user_id, $action, $details) {
    // 1. Validate User ID (Crucial because of Foreign Key)
    if (empty($user_id) || !is_numeric($user_id)) {
        // If we don't have a user ID, we technically can't log to tbl_system_logs 
        // because of the foreign key constraint. You might want to log to a text file as fallback.
        error_log("Failed to log action '$action': No valid user_id provided.");
        return;
    }

    // 2. Keep internal IDs in relational columns, not in user-facing details.
    $details = log_professionalize_details($mysqli, $action, $details);

    // 3. Resolve the address using the shared proxy-aware helper.
    $ip = get_client_ip_address();

    // 4. Prepare Query
    // Note: 'timestamp' is usually handled by MySQL (CURRENT_TIMESTAMP), 
    // but if your schema requires it explicitly, we use NOW().
    $sql = "INSERT INTO tbl_system_logs (user_id, action, timestamp, details, ip_address) VALUES (?, ?, NOW(), ?, ?)";
    
    $stmt = $mysqli->prepare($sql);
    
    if ($stmt) {
        $stmt->bind_param("isss", $user_id, $action, $details, $ip);
        $stmt->execute();
        $stmt->close();
    } else {
        error_log("Log Insert Error: " . $mysqli->error);
    }
}
?>
