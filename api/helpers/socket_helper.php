<?php
// Compatibility shim for existing API mutation hooks. Realtime Socket.IO was
// removed; pages refresh through their existing HTTPS polling instead.
if (!function_exists('trigger_socket_update')) {
    function trigger_socket_update($data) {
        return true;
    }
}
