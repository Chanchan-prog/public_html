<?php
// helpers/attedance-logs.php

/**
 * Write an attendance change to tbl_attendance_logs
 * Matches table columns: attendance_id, edit_session_id, edited_by, action_type, field_name, old_value, new_value, reason, ip_address, edited_at
 */
function log_attendance_change($mysqli, $actor_user_id, $attendance_id, $field_name, $old_value, $new_value, $reason = null, $ip_address = '', $action_type = 'update', $edit_session_id = '', $actor_name = null) {
    if (empty($attendance_id) || !is_numeric($attendance_id)) return;

    // Allowed action types
    $allowedActions = [
        'update', 'manual_adjust', 'correction', 'system_auto', 'reversion', 'approval', 'create', 'delete'
    ];
    $action = in_array($action_type, $allowedActions, true) ? $action_type : 'update';

    // Helper: map flag id to flag name when possible
    $mapFlag = function($val) use ($mysqli) {
        if ($val === null || $val === '') return null;
        if (is_numeric($val)) {
            $stmt = $mysqli->prepare("SELECT flag_name FROM tbl_flag_types WHERE flag_id = ? LIMIT 1");
            if ($stmt) {
                $fid = (int)$val;
                $stmt->bind_param('i', $fid);
                $stmt->execute();
                $res = $stmt->get_result()->fetch_assoc();
                $stmt->close();
                if ($res && isset($res['flag_name'])) return $res['flag_name'];
            }
            return (string)$val;
        }
        return (string)$val;
    };

    // Helper: format datetime values
    $formatTime = function($val) {
        if ($val === null || $val === '') return 'Not set';
        $ts = strtotime((string)$val);
        if ($ts === false) return (string)$val;
        return date('Y-m-d H:i:s', $ts);
    };

    // Determine field type
    $isTimeField = false;
    $isFlagField = false;
    $lname = strtolower((string)$field_name);
    if (strpos($lname, 'time') !== false || strpos($lname, 'checked_') !== false) {
        $isTimeField = true;
    }
    if (strpos($lname, 'flag') !== false || strpos($lname, 'flag_') !== false) {
        $isFlagField = true;
    }

    // Prepare display values
    $oldDisplay = $old_value;
    $newDisplay = $new_value;

    if ($isFlagField) {
        $oldDisplay = $mapFlag($old_value);
        $newDisplay = $mapFlag($new_value);
    }

    if ($isTimeField) {
        $oldDisplay = $formatTime($old_value);
        $newDisplay = $formatTime($new_value);
    }

    // Normalize to strings for DB storage
    $oldStr = $oldDisplay === null ? null : (string)$oldDisplay;
    $newStr = $newDisplay === null ? null : (string)$newDisplay;

    // Only clear old/new for fields that are neither time nor flag
    if (!$isTimeField && !$isFlagField) {
        $oldStr = null;
        $newStr = null;
    }

    // Resolve actor name if not supplied
    $resolvedActorName = null;
    if (!empty($actor_name)) {
        $resolvedActorName = trim((string)$actor_name);
    } elseif (!empty($actor_user_id) && is_numeric($actor_user_id) && $actor_user_id > 0) {
        $nameStmt = $mysqli->prepare("SELECT CONCAT_WS(' ', first_name, last_name) AS full_name FROM tbl_users WHERE user_id = ? LIMIT 1");
        if ($nameStmt) {
            $uid = (int)$actor_user_id;
            $nameStmt->bind_param('i', $uid);
            $nameStmt->execute();
            $nr = $nameStmt->get_result()->fetch_assoc();
            $nameStmt->close();
            if ($nr && !empty($nr['full_name'])) $resolvedActorName = trim($nr['full_name']);
        }
    }

    // Ensure professional reason exists and use resolved actor name if available
    if ($reason === null || trim((string)$reason) === '') {
        $editorPart = '';
        if (!empty($resolvedActorName)) {
            $editorPart = ' by ' . $resolvedActorName;
        } elseif (!empty($actor_user_id)) {
            $editorPart = ' by user #' . (int)$actor_user_id;
        } else {
            $editorPart = ' by system';
        }
        $fieldLabel = str_replace(['_', '-'], ' ', $field_name);
        if ($isTimeField) {
            $reason = sprintf("Attendance %s updated%s: changed from '%s' to '%s'.", ucfirst($fieldLabel), $editorPart, $oldStr ?? 'Not set', $newStr ?? 'Not set');
        } elseif ($isFlagField) {
            // include human-readable old/new for flags
            $reason = sprintf("Attendance %s updated%s: changed from '%s' to '%s'.", ucfirst($fieldLabel), $editorPart, $oldStr ?? 'Not set', $newStr ?? 'Not set');
        } else {
            $reason = sprintf("Attendance %s updated%s.", ucfirst($fieldLabel), $editorPart);
        }
    } else {
        // Normalize supplied reason: trim, capitalize, ensure period
        $r = trim((string)$reason);
        $r = rtrim($r, " \t\n\r\0\x0B.!");
        $r = ucfirst($r) . '.';
        $reason = $r;
    }

    // Limit IP address and edit_session_id length
    $ip = substr((string)($ip_address ?? ''), 0, 50);
    $edit_sess = substr((string)($edit_session_id ?? ''), 0, 100);

    $a_id = (int)$attendance_id;
    $edited_by = $actor_user_id !== null ? (int)$actor_user_id : null;
    if ($edited_by === null) { $edited_by = 0; }

    $sql = "INSERT INTO tbl_attendance_logs (attendance_id, edit_session_id, edited_by, action_type, field_name, old_value, new_value, reason, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
    $stmt = $mysqli->prepare($sql);
    if (!$stmt) {
        error_log("log_attendance_change prepare failed: " . $mysqli->error);
        return;
    }

    $stmt->bind_param('isissssss', $a_id, $edit_sess, $edited_by, $action, $field_name, $oldStr, $newStr, $reason, $ip);
    $stmt->execute();
    $stmt->close();
}
