// app-11-avatar-persist.js — v40 PERMANENT PROFILE-PHOTO PERSISTENCE.
//
// The incident being fixed: a user uploads a photo, it appears, they log
// out, log back in — and the photo is gone. Root causes this module kills:
//
//   R1. The old restore order preferred localStorage('jt_avatar') over the
//       DB's avatar_url. The local cache is device-bound, dies with storage
//       clears, and — worse — it can hold a photo whose cloud upload FAILED
//       (the DB write never landed). The user sees a "saved" photo that
//       exists nowhere permanent. LAW: the DATABASE is the source of truth;
//       the cache is a display accelerator, never the authority.
//
//   R2. The old upload path applied the photo to the UI optimistically and
//       reported success from a fire-and-forget chain whose failures were a
//       console.warn. "Photo saved ✓" appeared even when nothing persisted.
//       LAW: success is reported ONLY after a verified round-trip — the
//       object serves publicly AND a re-select of the DB row returns the
//       exact stored URL.
//
//   R3. A failed cloud sync never retried on its own. Every photo lost this
//       way was lost permanently on the next device switch. LAW: self-heal
//       — if the local cache exists but the DB row has no avatar_url, the
//       next login re-uploads it to the cloud automatically.
//
//   R4. Removal only cleared the cache and blanked the DB column; the
//       storage object stayed behind. Re-uploads could resurrect stale
//       objects. LAW: removal clears all three layers — DB reference,
//       storage object, local cache.
//
// All four laws are testable via window.__avatarPersist (test hook).

const AV_MAX_FILE_BYTES = 2 * 1024 * 1024;   // hard client cap (matches bucket)

// v40 user-scoped cache key: jt_avatar was shared across ALL users of a
// browser, so on a shared device user B's first paint showed user A's photo
// while B's row loaded. The cache is now per-uid; the legacy unscoped key is
// migrated transparently (read once for the CURRENT user, then rewritten
// scoped). All reads/writes go through these helpers — nothing else touches
// localStorage for avatars.
function avCacheKey() { return currentUser ? `jt_avatar_${currentUser.id}` : 'jt_avatar'; }
function avCacheGet() {
  if (!currentUser) return null;
  const scoped = localStorage.getItem(`jt_avatar_${currentUser.id}`);
  if (scoped) return scoped;
  const legacy = localStorage.getItem('jt_avatar');
  if (legacy) { try { localStorage.setItem(`jt_avatar_${currentUser.id}`, legacy); localStorage.removeItem('jt_avatar'); } catch (_) {} return legacy; }
  return null;
}
function avCacheSet(dataUrl) { if (!currentUser) return; try { localStorage.setItem(`jt_avatar_${currentUser.id}`, dataUrl); } catch (_) {} }
function avCacheRemove() {
  if (!currentUser) return;
  try { localStorage.removeItem(`jt_avatar_${currentUser.id}`); } catch (_) {}
  try { localStorage.removeItem('jt_avatar'); } catch (_) {}
}
const AV_OPTIMIZE_ABOVE = 300 * 1024;         // downscale above this size
const AV_MAX_DIM = 512;                       // avatar render box is ~96px; 512 is generous
const AV_JPEG_QUALITY = 0.85;
const AV_UPLOAD_ATTEMPTS = 3;

// ── validation ────────────────────────────────────────────────────────────
function avatarValidateFile(file) {
  if (!file) return { ok: false, reason: 'no file' };
  if (!file.type || !file.type.startsWith('image/')) return { ok: false, reason: 'type' };
  if (file.size > AV_MAX_FILE_BYTES) return { ok: false, reason: 'size' };
  return { ok: true };
}

// ── optimization: downscale to a bounded square-ish canvas, jpeg ─────────
async function avatarOptimize(dataUrl) {
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    if (img.width <= AV_MAX_DIM && img.height <= AV_MAX_DIM) return dataUrl;
    const canvas = document.createElement('canvas');
    const scale = Math.min(AV_MAX_DIM / img.width, AV_MAX_DIM / img.height, 1);
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', AV_JPEG_QUALITY);
  } catch (_) { return dataUrl; }
}

// ── the verified persistence round-trip (R2) ─────────────────────────────
// Stages: 0.1 validate → 0.25 upload → 0.5 verify-served → 0.75 db-write →
// 1.0 db-reselect. Only a FULL pass returns ok:true.
async function persistAvatarToCloud(dataUrl, onProgress) {
  const report = (stage, p) => { try { (onProgress || (() => {}))(stage, p); } catch (_) {} };
  const state = window.__avatarPersist;
  if (!sb || !currentUser) return { ok: false, stage: 'offline', error: 'not signed in' };

  try {
    report('uploading', 0.25);
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
    const path = `${currentUser.id}/avatar.${ext}`;

    // upsert with retries — transient 5xx/policy hiccups are the classic
    // "photo vanished" producers, so we make up to three honest attempts
    let uploadErr = null;
    for (let attempt = 1; attempt <= AV_UPLOAD_ATTEMPTS; attempt++) {
      try {
        await sb.storage.from('avatars').upload(path, blob, { upsert: true, contentType: blob.type });
        uploadErr = null;
        break;
      } catch (e) { uploadErr = e; await new Promise(r => setTimeout(r, 350 * attempt)); }
    }
    if (uploadErr) return { ok: false, stage: 'upload', error: String(uploadErr.message || uploadErr) };
    if (state) state.lastUploadPath = path;

    report('verifying', 0.5);
    const { data: urlData } = sb.storage.from('avatars').getPublicUrl(path);
    const publicUrl = urlData?.publicUrl;
    if (!publicUrl) return { ok: false, stage: 'url', error: 'no public url' };
    const verify = await fetch(publicUrl, { method: 'GET', cache: 'no-store' });
    if (!verify.ok) return { ok: false, stage: 'serve', error: `object not served (${verify.status})` };

    report('saving', 0.75);
    // cache-buster: the public URL is stable per path, so a REPLACED photo
    // would render from CDN/browser cache without the ?v= bump
    const busted = `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
    await saveUserProfile({ avatar_url: busted });
    userProfile.avatar_url = busted;

    report('confirming', 0.9);
    // R2 confirmation: re-select the row and require the exact URL back
    const { data: row, error } = await sb.from('user_preferences')
      .select('avatar_url').eq('user_id', currentUser.id).single();
    if (error || !row || row.avatar_url !== busted) {
      return { ok: false, stage: 'confirm', error: error ? String(error.message) : 'row did not keep the url' };
    }

    report('done', 1);
    avCacheSet(dataUrl);
    if (state) { state.lastPersistedUrl = busted; state.lastPersistedAt = Date.now(); }
    return { ok: true, url: busted };
  } catch (e) {
    return { ok: false, stage: 'exception', error: String(e && e.message || e) };
  }
}

// ── restore order (R1): DATABASE first, cache only as fallback ────────────
function restoreAvatarSrc() {
  const dbUrl = userProfile && userProfile.avatar_url;
  const cached = avCacheGet();
  return { src: dbUrl || cached || '', from: dbUrl ? 'db' : cached ? 'cache' : 'none' };
}

// ── self-healing (R3): cache present but DB empty → re-upload ────────────
async function resyncLocalAvatarIfMissing() {
  if (!sb || !currentUser) return { ran: false };
  const cached = avCacheGet();
  if (!cached) return { ran: false, reason: 'no cache' };
  if (userProfile && userProfile.avatar_url) return { ran: false, reason: 'db already has it' };
  const out = await persistAvatarToCloud(cached, null);
  if (state) state.lastResync = out;
  return { ran: true, result: out };
}

// ── removal (R4): all three layers ───────────────────────────────────────
async function removeAvatarEverywhere() {
  avCacheRemove();
  _clearAvatarImage();
  if (!sb || !currentUser) { return { ok: true, note: 'local only (offline)' }; }
  try {
    await saveUserProfile({ avatar_url: '' });
    userProfile.avatar_url = '';
    // remove every known avatar extension object — a stale avatar.png would
    // otherwise resurrect on the next png upload even after a jpg replace
    const exts = ['png', 'jpg', 'jpeg', 'webp', 'svg'];
    await Promise.all(exts.map(ext =>
      sb.storage.from('avatars').remove(`${currentUser.id}/avatar.${ext}`).catch(() => {})
    ));
    if (state) state.lastRemovedAt = Date.now();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ── test hook (also used by the E2E suite to observe the chain) ───────────
const state = { lastUploadPath: null, lastPersistedUrl: null, lastPersistedAt: null, lastResync: null, lastRemovedAt: null };
window.__avatarPersist = state;
