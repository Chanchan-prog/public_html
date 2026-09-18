<?php
require_once __DIR__ . '/../helpers/security_policy_helper.php';
require_once __DIR__ . '/../helpers/log_helper.php';
global $mysqli, $authPayload;

$roleId = (int)($authPayload['role_id'] ?? 0);
if ($roleId !== 1) json_response(['error'=>'forbidden','message'=>'Only Admin can manage system security settings.'],403);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$parts = explode('/', trim($path,'/')); $apiIndex=array_search('api',$parts); $section=$parts[$apiIndex+2] ?? '';
$input = get_input(); if (!is_array($input)) $input=[];

if ($section === 'security-policy') {
    if ($method === 'GET') json_response(['policy'=>security_policy_get($mysqli),'limits'=>security_policy_limits()]);
    if (!in_array($method,['PUT','POST'],true)) json_response(['error'=>'method_not_allowed'],405);
    $policy=security_policy_normalize($input); security_policy_ensure_table($mysqli); $mysqli->begin_transaction();
    $mysqli->query("DELETE FROM tbl_app_settings WHERE setting_group='security' AND dept_id IS NULL");
    $stmt=$mysqli->prepare("INSERT INTO tbl_app_settings(setting_group,dept_id,setting_key,setting_value,value_type,updated_by) VALUES('security',NULL,?,?, 'integer',?)");
    foreach($policy as $key=>$value){$string=(string)$value;$uid=(int)$authPayload['user_id'];$stmt->bind_param('ssi',$key,$string,$uid);$stmt->execute();}
    $stmt->close(); $mysqli->commit(); log_system_action($mysqli,(int)$authPayload['user_id'],'update_security_policy','Updated login, session, and password security policy.');
    json_response(['ok'=>true,'policy'=>security_policy_get($mysqli)]);
}

if ($section === 'activity') {
    $actions=['update_user_module_access','send_temporary_password','temporary_password_email_failed','unlock_login_account','update_security_policy','update_app_settings'];
    $quoted="'".implode("','",$actions)."'";
    $pageSize=max(1,min(10,(int)($_GET['page_size']??10)));
    $page=max(1,(int)($_GET['page']??1));
    $countResult=$mysqli->query("SELECT COUNT(*) AS total FROM tbl_system_logs l WHERE l.action IN ({$quoted})");
    $total=$countResult?(int)($countResult->fetch_assoc()['total']??0):0;
    $totalPages=max(1,(int)ceil($total/$pageSize));
    $page=min($page,$totalPages);
    $offset=($page-1)*$pageSize;
    $res=$mysqli->query("SELECT l.log_id,l.action,l.timestamp,l.details,l.ip_address,CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) actor_name FROM tbl_system_logs l LEFT JOIN tbl_users u ON u.user_id=l.user_id WHERE l.action IN ({$quoted}) ORDER BY l.timestamp DESC LIMIT {$pageSize} OFFSET {$offset}");
    $rows=$res?$res->fetch_all(MYSQLI_ASSOC):[];
    foreach($rows as &$row){$row['ip_address']=format_ip_address_for_display($row['ip_address']??'');}
    unset($row);
    json_response(['rows'=>$rows,'pagination'=>['page'=>$page,'page_size'=>$pageSize,'total'=>$total,'total_pages'=>$totalPages]]);
}

if ($section === 'health') {
    $columns=[]; foreach(['token_version','temporary_password_expires_at','temporary_password_sent_at'] as $column){$res=$mysqli->query("SHOW COLUMNS FROM tbl_users LIKE '{$column}'");$columns[$column]=(bool)($res&&$res->num_rows);}
    $sessionTable=$mysqli->query("SHOW TABLES LIKE 'tbl_user_sessions'");
    $mailConfigured=(bool)(getenv('MAIL_SMTP_USER')&&getenv('MAIL_SMTP_PASS'));
    $csrfColumn=$mysqli->query("SHOW COLUMNS FROM tbl_user_sessions LIKE 'csrf_token_hash'");
    $cookieSessionsReady=(bool)($sessionTable&&$sessionTable->num_rows&&$csrfColumn&&$csrfColumn->num_rows);
    $https=(!empty($_SERVER['HTTPS'])&&$_SERVER['HTTPS']!=='off')||strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO']??''))==='https';
    json_response(['checks'=>[
        ['key'=>'https','label'=>'HTTPS request','ok'=>$https],
        ['key'=>'mail','label'=>'Mail environment variables','ok'=>$mailConfigured],
        ['key'=>'session','label'=>'Secure database cookie sessions','ok'=>$cookieSessionsReady],
        ['key'=>'migration','label'=>'Admin security migration','ok'=>!in_array(false,$columns,true)&&(bool)($sessionTable&&$sessionTable->num_rows)],
    ]]);
}
json_response(['error'=>'not_found'],404);
