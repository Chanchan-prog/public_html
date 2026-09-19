// Minimal GPS utility functions ported from the project
function toRadians(deg) { return deg * Math.PI / 180; }
function getDistanceMeters(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
  const R = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function isInsideBox(coords, room) {
  if (!coords || !room) return false;
  const dist = getDistanceMeters(coords.latitude, coords.longitude, room.latitude, room.longitude);
  return dist <= (room.radius || 30);
}

function formatDateYMD(d) {
  return d.toISOString().slice(0,10);
}

function formatTime12(t) {
  if (!t) return '';
  const dt = new Date(`1970-01-01T${t}`);
  return dt.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

function pad2(n){ return String(n).padStart(2,'0'); }
