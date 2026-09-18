<?php

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    json_response(['ok' => false, 'error' => 'method_not_allowed'], 405);
}

// Authentication and the database session touch are handled centrally before
// this endpoint is loaded. This response gives the browser a lightweight way
// to keep an actively used session synchronized with the server.
json_response(['ok' => true, 'synced_at' => date(DATE_ATOM)]);
