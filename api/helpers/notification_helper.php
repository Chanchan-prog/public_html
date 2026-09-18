<?php

require_once __DIR__ . '/personal_notification_helper.php';
require_once __DIR__ . '/push_notification_helper.php';

function notif_table_exists($mysqli) {
    static $checked = null;
    if ($checked !== null) return $checked;
    $res = $mysqli->query("SHOW TABLES LIKE 'tbl_notifications'");
    $checked = (bool)($res && (int)$res->num_rows > 0);
    return $checked;
}

function notif_trim_text($value, $maxLen) {
    $text = trim((string)$value);
    if ($text === '') return '';
    if (function_exists('mb_substr')) return mb_substr($text, 0, $maxLen);
    return substr($text, 0, $maxLen);
}

function notif_with_actor_link($link, $actorUserId = null) {
    $cleanLink = notif_trim_text($link, 100);
    $actorId = $actorUserId !== null ? (int)$actorUserId : 0;
    if ($cleanLink === '' || $actorId <= 0) return $cleanLink;
    $sep = (strpos($cleanLink, '?') !== false) ? '&' : '?';
    return notif_trim_text($cleanLink . $sep . 'actor=' . $actorId, 100);
}

function notif_insert_channels($mysqli, $userId, $title, $message, $link = '', $actorUserId = null, $sendEmail = true) {
    $uid = (int)$userId;
    if ($uid <= 0) return false;
    if (!notif_table_exists($mysqli)) return false;

    $cleanTitle = notif_trim_text($title, 200);
    $cleanMessage = notif_trim_text($message, 5000);
    $cleanLink = notif_with_actor_link($link, $actorUserId);
    if ($cleanTitle === '' || $cleanMessage === '') return false;

    $sql = "INSERT INTO tbl_notifications (user_id, title, message, link, is_read, created_at) VALUES (?, ?, ?, ?, 0, NOW())";
    $stmt = $mysqli->prepare($sql);
    if (!$stmt) return false;
    $stmt->bind_param('isss', $uid, $cleanTitle, $cleanMessage, $cleanLink);
    $ok = $stmt->execute();
    $notificationId = $ok ? (int)$stmt->insert_id : 0;
    $stmt->close();
    if ($ok) {
        if ($sendEmail) {
            personal_notif_send_general_update($mysqli, $uid, $cleanTitle, $cleanMessage, new DateTime());
        }
        push_send_notification($mysqli, $uid, $notificationId, $cleanTitle, $cleanMessage, $cleanLink);
    }
    return (bool)$ok;
}

function notif_insert($mysqli, $userId, $title, $message, $link = '', $actorUserId = null) {
    return notif_insert_channels($mysqli, $userId, $title, $message, $link, $actorUserId, true);
}

// Add the website record and Web Push without email. Use this for routine
// alerts or when a dedicated email has already been sent separately.
function notif_insert_web_push($mysqli, $userId, $title, $message, $link = '', $actorUserId = null) {
    return notif_insert_channels($mysqli, $userId, $title, $message, $link, $actorUserId, false);
}

function notif_insert_many($mysqli, $userIds, $title, $message, $link = '', $actorUserId = null) {
    if (!is_array($userIds) || empty($userIds)) return 0;
    $sent = 0;
    $seen = [];
    foreach ($userIds as $uidRaw) {
        $uid = (int)$uidRaw;
        if ($uid <= 0 || isset($seen[$uid])) continue;
        $seen[$uid] = true;
        if (notif_insert($mysqli, $uid, $title, $message, $link, $actorUserId)) {
            $sent++;
        }
    }
    return $sent;
}

function notif_get_user_ids_by_role_dept($mysqli, $roleId, $deptId, $excludeUserId = null) {
    $rid = (int)$roleId;
    $did = ($deptId === null) ? null : (int)$deptId;
    $exclude = ($excludeUserId === null) ? null : (int)$excludeUserId;
    if ($rid <= 0 || $did === null) return [];

    $sql = "SELECT user_id FROM tbl_users WHERE role_id = ? AND dept_id = ? AND status = 'active'";
    $types = 'ii';
    $params = [$rid, $did];
    if ($exclude !== null && $exclude > 0) {
        $sql .= " AND user_id <> ?";
        $types .= 'i';
        $params[] = $exclude;
    }

    $stmt = $mysqli->prepare($sql);
    if (!$stmt) return [];
    if (count($params) === 2) {
        $stmt->bind_param($types, $params[0], $params[1]);
    } else {
        $stmt->bind_param($types, $params[0], $params[1], $params[2]);
    }
    $stmt->execute();
    $res = $stmt->get_result();
    $ids = [];
    while ($row = $res->fetch_assoc()) {
        $ids[] = (int)$row['user_id'];
    }
    $stmt->close();
    return $ids;
}

function notif_notify_role_dept($mysqli, $roleId, $deptId, $title, $message, $link = '', $excludeUserId = null, $actorUserId = null) {
    $ids = notif_get_user_ids_by_role_dept($mysqli, $roleId, $deptId, $excludeUserId);
    return notif_insert_many($mysqli, $ids, $title, $message, $link, $actorUserId);
}

function notif_get_user_full_name($mysqli, $userId) {
    $uid = (int)$userId;
    if ($uid <= 0) return 'Teacher';
    $stmt = $mysqli->prepare("SELECT first_name, last_name FROM tbl_users WHERE user_id = ? LIMIT 1");
    if (!$stmt) return 'Teacher';
    $stmt->bind_param('i', $uid);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row) return 'Teacher';
    $full = trim((string)($row['first_name'] ?? '') . ' ' . (string)($row['last_name'] ?? ''));
    return $full !== '' ? $full : 'Teacher';
}
