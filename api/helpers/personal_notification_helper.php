<?php
// api/helpers/personal_notification_helper.php

require_once __DIR__ . '/mail_helper.php';

function personal_notif_clean_text($value, $maxLen = 1000) {
    $text = trim((string)$value);
    if ($text === '') return '';
    $text = preg_replace('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', '[email hidden]', $text);
    $text = preg_replace('/[\r\n\t]+/', ' ', $text);
    $text = preg_replace('/\s{2,}/', ' ', $text);
    $text = trim((string)$text);
    if ($maxLen > 0 && strlen($text) > $maxLen) {
        $text = substr($text, 0, $maxLen);
    }
    return $text;
}

function personal_notif_log_failure($userId, $notificationType, $reason) {
    $uid = (int)$userId;
    $type = personal_notif_clean_text($notificationType, 80);
    $why = personal_notif_clean_text($reason, 200);
    error_log("[personal_notification] failed user_id={$uid} type={$type} reason={$why}");
}

function personal_notif_get_user_profile($mysqli, $userId) {
    $uid = (int)$userId;
    if ($uid <= 0) return null;

    $stmt = $mysqli->prepare("SELECT user_id, first_name, email FROM tbl_users WHERE user_id = ? LIMIT 1");
    if (!$stmt) return null;
    $stmt->bind_param('i', $uid);
    if (!$stmt->execute()) {
        $stmt->close();
        return null;
    }
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return $row ?: null;
}

function personal_notif_send_to_user($mysqli, $userId, $notificationType, $briefDescription, $eventDetails, $eventDateTime = null) {
    $uid = (int)$userId;
    if ($uid <= 0) {
        personal_notif_log_failure($uid, $notificationType, 'invalid user id');
        return ['sent' => false, 'error' => 'invalid_user_id'];
    }

    $profile = personal_notif_get_user_profile($mysqli, $uid);
    if (!$profile) {
        personal_notif_log_failure($uid, $notificationType, 'user profile not found');
        return ['sent' => false, 'error' => 'user_not_found'];
    }

    $recipient = trim((string)($profile['email'] ?? ''));
    if (!mail_helper_is_single_recipient($recipient)) {
        personal_notif_log_failure($uid, $notificationType, 'missing or invalid registered email');
        return ['sent' => false, 'error' => 'missing_or_invalid_registered_email'];
    }

    $type = strtoupper(personal_notif_clean_text($notificationType, 80));
    if ($type === '') $type = 'GENERAL';
    $brief = personal_notif_clean_text($briefDescription, 180);
    if ($brief === '') $brief = 'Account notification';
    $details = personal_notif_clean_text($eventDetails, 1000);
    if ($details === '') $details = 'A system update was recorded for your account.';
    $firstName = personal_notif_clean_text($profile['first_name'] ?? '', 100);

    try {
        $sent = send_personal_notification_email(
            $recipient,
            $firstName,
            $type,
            $brief,
            $details,
            $eventDateTime
        );
    } catch (Throwable $e) {
        personal_notif_log_failure($uid, $type, 'mail exception: ' . $e->getMessage());
        return ['sent' => false, 'error' => 'mail_exception'];
    }

    if (!$sent) {
        personal_notif_log_failure($uid, $type, 'mail delivery failed');
        return ['sent' => false, 'error' => 'mail_delivery_failed'];
    }

    return ['sent' => true, 'error' => null];
}

function personal_notif_format_time($value) {
    $raw = trim((string)$value);
    if ($raw === '') return '';
    $ts = strtotime($raw);
    if ($ts === false) return personal_notif_clean_text($raw, 30);
    return date('h:i A', $ts);
}

function personal_notif_attendance_details($record, $lead) {
    $parts = [];
    $leadText = personal_notif_clean_text($lead, 250);
    if ($leadText !== '') $parts[] = $leadText;

    $subjectCode = personal_notif_clean_text($record['subject_code'] ?? '', 80);
    $subjectName = personal_notif_clean_text($record['subject_name'] ?? '', 160);
    $subject = trim($subjectCode . ($subjectCode !== '' && $subjectName !== '' ? ' - ' : '') . $subjectName);
    if ($subject !== '') $parts[] = 'Class: ' . $subject;

    $section = personal_notif_clean_text($record['section_name'] ?? '', 100);
    if ($section !== '') $parts[] = 'Section: ' . $section;

    $room = personal_notif_clean_text($record['room_name'] ?? '', 100);
    if ($room !== '') $parts[] = 'Room: ' . $room;

    $date = personal_notif_clean_text($record['date'] ?? '', 20);
    $start = personal_notif_format_time($record['start_time'] ?? '');
    $end = personal_notif_format_time($record['end_time'] ?? '');
    $schedule = trim($date . (($start !== '' || $end !== '') ? ' ' : '') . $start . (($start !== '' && $end !== '') ? ' - ' : '') . $end);
    if ($schedule !== '') $parts[] = 'Schedule: ' . $schedule;

    if (empty($parts)) {
        return 'Attendance status was updated for your account.';
    }
    return implode(' | ', $parts);
}

function personal_notif_send_attendance_event($mysqli, $record, $notificationType, $briefDescription, $leadDetails, $eventDateTime = null) {
    $userId = isset($record['user_id']) ? (int)$record['user_id'] : 0;
    $details = personal_notif_attendance_details(is_array($record) ? $record : [], $leadDetails);
    return personal_notif_send_to_user($mysqli, $userId, $notificationType, $briefDescription, $details, $eventDateTime);
}

function personal_notif_send_general_update($mysqli, $userId, $briefDescription, $eventDetails, $eventDateTime = null) {
    return personal_notif_send_to_user($mysqli, $userId, 'GENERAL', $briefDescription, $eventDetails, $eventDateTime);
}
