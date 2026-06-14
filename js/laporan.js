/* =====================================================================
 * LAPORAN WARGA — laporan.js
 * Real-time citizen disaster reporting via Firebase Firestore.
 *
 * Public API (dipanggil dari HTML onclick atau script.js):
 *   initLaporan(map)       — dipanggil sekali di main()
 *   openLaporanModal()     — buka form laporan baru
 *   closeLaporanModal()    — tutup modal
 *   startMapPick()         — mode klik peta untuk pilih lokasi
 *   cancelMapPick()        — batal mode klik peta, buka ulang modal
 *   useGPSForLaporan()     — isi lokasi dari GPS perangkat
 *   submitLaporan()        — kirim laporan ke Firestore
 *   flyToLaporan(id)       — terbang ke marker laporan tertentu
 *   openAdminModal()       — buka login admin
 *   closeAdminModal()      — tutup login admin
 *   tryAdminLogin()        — proses login admin
 *   adminLogout()          — keluar dari mode admin
 *   deleteLaporan(id)      — hapus laporan (admin only)
 * ===================================================================== */
"use strict";

/* ---------- Konfigurasi jenis bencana ---------- */
const JENIS_CFG = {
  "Longsor":       { color: "#ef4444", symbol: "⚠️" },
  "Tanah Retak":   { color: "#f97316", symbol: "⚡" },
  "Banjir":        { color: "#3b82f6", symbol: "💧" },
  "Pohon Tumbang": { color: "#22c55e", symbol: "🌳" },
  "Lainnya":       { color: "#94a3b8", symbol: "📍" },
};

/* ---------- Kredensial Admin (hanya diketahui pemilik website) ---------- */
const _ADMIN_USER = "sigapadmin";
const _ADMIN_PASS = "Sigap@2026";

/* ---------- State ---------- */
let _map     = null;
let _markers = {};     // docId → { marker, data }
let _allDocs = [];     // semua laporan (desc by timestamp)
let _picking = false;  // true = sedang mode pilih lokasi di peta
let _picked  = null;   // { lat, lng } hasil pilih lokasi
let _isAdmin = false;  // true = mode admin aktif

/* =====================================================================
 * 1. INISIALISASI
 * ===================================================================== */
function initLaporan(map) {
  _map = map;
  _checkAdminSession();   // pulihkan session admin jika ada
  _setupMapClickPick();
  _listenLaporan();
}

/* =====================================================================
 * 2. FIRESTORE REAL-TIME LISTENER
 * ===================================================================== */
function _listenLaporan() {
  db.collection("laporan")
    .orderBy("timestamp", "desc")
    .limit(100)
    .onSnapshot(
      (snap) => {
        /* Rebuild array laporan */
        _allDocs = [];
        const liveIds = new Set();
        snap.forEach((doc) => {
          const data = { id: doc.id, ...doc.data() };
          _allDocs.push(data);
          liveIds.add(doc.id);
        });

        /* Hapus marker yang sudah dihapus dari Firestore */
        Object.keys(_markers).forEach((id) => {
          if (!liveIds.has(id)) _removeMarker(id);
        });

        /* Tambahkan marker baru */
        _allDocs.forEach((d) => {
          if (!_markers[d.id]) _addMarker(d);
        });

        _renderSidebarList();
        _updateBadge(_allDocs.length);
      },
      (err) => {
        console.error("[LaporanWarga] Firestore error:", err);
      }
    );
}

/* =====================================================================
 * 3. MARKER
 * ===================================================================== */
function _addMarker(data) {
  if (data.lat == null || data.lng == null) return;
  const cfg = JENIS_CFG[data.jenis] || JENIS_CFG["Lainnya"];

  const icon = L.divIcon({
    className: "",
    html: `<div class="rpt-pin" style="--rpt-clr:${cfg.color}">
             <div class="rpt-pulse"></div>
             <div class="rpt-dot">${cfg.symbol}</div>
           </div>`,
    iconSize:    [42, 42],
    iconAnchor:  [21, 21],
    popupAnchor: [0, -24],
  });

  const marker = L.marker([data.lat, data.lng], { icon })
    .bindPopup(_buildPopup(data), { maxWidth: 300 });

  marker.addTo(_map);
  _markers[data.id] = { marker, data };
}

function _removeMarker(id) {
  if (!_markers[id]) return;
  _map.removeLayer(_markers[id].marker);
  delete _markers[id];
}

/* =====================================================================
 * 4. POPUP
 * ===================================================================== */
function _buildPopup(data) {
  const cfg  = JENIS_CFG[data.jenis] || JENIS_CFG["Lainnya"];
  const ts   = data.timestamp?.toDate?.() ?? new Date();
  const time = ts.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });

  return `
    <div class="popup-title" style="color:${cfg.color}">
      ${cfg.symbol} Laporan Warga
    </div>
    <div class="popup-row">
      <span>Jenis</span>
      <span class="badge" style="background:${cfg.color};color:#fff">${data.jenis}</span>
    </div>
    <div class="popup-row"><span>Pelapor</span><span>${data.nama || "Anonim"}</span></div>
    <div class="popup-row"><span>Waktu</span><span>${time}</span></div>
    ${data.deskripsi
      ? `<div class="rpt-desc">${data.deskripsi}</div>`
      : ""}
    <button class="rpt-delete-btn" onclick="deleteLaporan('${data.id}')">
      🗑️ Hapus Laporan
    </button>`;
}

/* =====================================================================
 * 5. MODAL — BUKA / TUTUP
 * ===================================================================== */
function openLaporanModal() {
  /* Fresh open: reset semua field */
  _picked = null;
  _setLocText("Belum dipilih", false);
  document.getElementById("laporJenis").value           = "Longsor";
  document.getElementById("laporDeskripsi").value        = "";
  document.getElementById("laporNama").value             = "";
  const btn = document.getElementById("btnSubmitLaporan");
  btn.disabled    = false;
  btn.textContent = "Kirim Laporan";

  document.getElementById("laporanModal").classList.add("open");
}

function closeLaporanModal() {
  document.getElementById("laporanModal").classList.remove("open");
  _cancelPick();
}

function _reopenModal() {
  /* Buka kembali modal tanpa reset form (setelah balik dari pilih peta) */
  if (_picked) {
    _setLocText(`${_picked.lat.toFixed(6)}, ${_picked.lng.toFixed(6)}`, true);
  }
  document.getElementById("laporanModal").classList.add("open");
}

function _setLocText(text, isOk) {
  const el = document.getElementById("laporLokasiText");
  el.textContent = text;
  el.className   = "laporan-loc-text" + (isOk ? " ok" : "");
}

/* =====================================================================
 * 6. PILIH LOKASI DI PETA
 * ===================================================================== */
function startMapPick() {
  document.getElementById("laporanModal").classList.remove("open");
  document.getElementById("laporPickHint").hidden = false;
  _map.getContainer().style.cursor = "crosshair";
  _picking = true;
}

function cancelMapPick() {
  _cancelPick();
  _reopenModal();
}

function _cancelPick() {
  _picking = false;
  if (_map) _map.getContainer().style.cursor = "";
  const hint = document.getElementById("laporPickHint");
  if (hint) hint.hidden = true;
}

function _setupMapClickPick() {
  _map.on("click", (e) => {
    if (!_picking) return;
    _picked = { lat: e.latlng.lat, lng: e.latlng.lng };
    _cancelPick();
    _reopenModal();
  });
}

/* =====================================================================
 * 7. GPS
 * ===================================================================== */
function useGPSForLaporan() {
  if (!navigator.geolocation) {
    alert("Browser tidak mendukung geolokasi.");
    return;
  }
  const btn = document.getElementById("btnLaporGPS");
  btn.disabled    = true;
  btn.textContent = "Mendeteksi…";

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      _picked = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      _setLocText(`${_picked.lat.toFixed(6)}, ${_picked.lng.toFixed(6)}`, true);
      btn.disabled    = false;
      btn.textContent = "GPS";
    },
    () => {
      alert("Gagal mendapatkan lokasi GPS. Pastikan izin akses lokasi diberikan.");
      btn.disabled    = false;
      btn.textContent = "GPS";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/* =====================================================================
 * 8. SUBMIT KE FIRESTORE
 * ===================================================================== */
async function submitLaporan() {
  if (!_picked) {
    /* Shake animasi untuk ingatkan user */
    const el = document.getElementById("laporLokasiText");
    el.classList.add("shake");
    setTimeout(() => el.classList.remove("shake"), 600);
    return;
  }

  const jenis     = document.getElementById("laporJenis").value;
  const deskripsi = document.getElementById("laporDeskripsi").value.trim();
  const nama      = document.getElementById("laporNama").value.trim() || "Anonim";
  const btn       = document.getElementById("btnSubmitLaporan");

  btn.disabled    = true;
  btn.textContent = "Mengirim…";

  try {
    await db.collection("laporan").add({
      jenis,
      deskripsi,
      nama,
      lat:       _picked.lat,
      lng:       _picked.lng,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      verified:  false,
    });

    const sentLoc = { ..._picked };
    closeLaporanModal();
    _showToast(`✅ Laporan "${jenis}" berhasil dikirim!`, "ok");
    _map.flyTo([sentLoc.lat, sentLoc.lng], 15, { duration: 1 });

  } catch (err) {
    console.error("[LaporanWarga] Submit error:", err);
    _showToast("❌ Gagal mengirim laporan. Coba lagi.", "err");
    btn.disabled    = false;
    btn.textContent = "Kirim Laporan";
  }
}

/* =====================================================================
 * 9. SIDEBAR PANEL
 * ===================================================================== */
function _renderSidebarList() {
  const list = document.getElementById("laporanList");
  if (!list) return;

  if (!_allDocs.length) {
    list.innerHTML = `<li class="laporan-empty">Belum ada laporan masuk.</li>`;
    return;
  }

  list.innerHTML = _allDocs.slice(0, 12).map((d) => {
    const cfg  = JENIS_CFG[d.jenis] || JENIS_CFG["Lainnya"];
    const ts   = d.timestamp?.toDate?.() ?? new Date();
    const rel  = _relTime(ts);
    const hex  = cfg.color;
    const bgHex = hex + "33"; /* ~20% opacity */
    return `
      <li class="laporan-item" onclick="flyToLaporan('${d.id}')">
        <span class="laporan-item-icon" style="background:${bgHex};border-color:${hex}">${cfg.symbol}</span>
        <div class="laporan-item-body">
          <strong>${d.jenis}</strong>
          <span>${d.nama || "Anonim"} · ${rel}</span>
        </div>
        <button class="laporan-delete-btn"
          onclick="event.stopPropagation();deleteLaporan('${d.id}')"
          title="Hapus laporan ini">🗑️</button>
        <span class="laporan-item-arrow">›</span>
      </li>`;
  }).join("");
}

function flyToLaporan(id) {
  const entry = _markers[id];
  if (!entry) return;
  _map.flyTo([entry.data.lat, entry.data.lng], 16, { duration: 0.9 });
  setTimeout(() => entry.marker.openPopup(), 950);
}

function _updateBadge(n) {
  const el = document.getElementById("laporanBadge");
  if (!el) return;
  el.textContent     = n > 99 ? "99+" : n;
  el.style.display   = n > 0 ? "inline-flex" : "none";
}

/* =====================================================================
 * 10. HELPERS
 * ===================================================================== */
function _relTime(date) {
  const s = (Date.now() - date.getTime()) / 1000;
  if (s < 60)    return "baru saja";
  if (s < 3600)  return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hr lalu`;
}

function _showToast(msg, type) {
  const toast = document.getElementById("laporanToast");
  if (!toast) return;
  toast.textContent = msg;
  toast.className   = `laporan-toast ${type} visible`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("visible"), 3500);
}

/* =====================================================================
 * 11. ADMIN MODE
 * ===================================================================== */

/* Cek apakah ada sesi admin yang tersimpan */
function _checkAdminSession() {
  if (sessionStorage.getItem("sigap_admin") === "1") {
    _isAdmin = true;
    document.body.classList.add("admin-active");
  }
}

/* Buka modal login admin */
function openAdminModal() {
  document.getElementById("adminUser").value = "";
  document.getElementById("adminPass").value = "";
  document.getElementById("adminLoginErr").hidden = true;
  document.getElementById("adminModal").classList.add("open");
  setTimeout(() => document.getElementById("adminUser").focus(), 200);
}

function closeAdminModal() {
  document.getElementById("adminModal").classList.remove("open");
}

/* Proses login */
function tryAdminLogin() {
  const user = document.getElementById("adminUser").value.trim();
  const pass = document.getElementById("adminPass").value;

  if (user === _ADMIN_USER && pass === _ADMIN_PASS) {
    _isAdmin = true;
    sessionStorage.setItem("sigap_admin", "1");
    document.body.classList.add("admin-active");
    closeAdminModal();
    _showToast("🔐 Mode Admin aktif — hapus laporan dengan tombol 🗑️", "ok");
  } else {
    /* Animasi shake pada card */
    const card = document.getElementById("adminModalCard");
    card.classList.remove("shake");
    void card.offsetWidth;
    card.classList.add("shake");
    document.getElementById("adminLoginErr").hidden = false;
    document.getElementById("adminPass").value = "";
    document.getElementById("adminPass").focus();
  }
}

/* Keluar mode admin */
function adminLogout() {
  _isAdmin = false;
  sessionStorage.removeItem("sigap_admin");
  document.body.classList.remove("admin-active");
  _showToast("👋 Mode Admin dinonaktifkan", "ok");
}

/* Toggle: klik lock = masuk admin / klik lagi = keluar */
function toggleAdminMode() {
  if (_isAdmin) {
    adminLogout();
  } else {
    openAdminModal();
  }
}

/* Hapus laporan dari Firestore */
async function deleteLaporan(id) {
  if (!_isAdmin) return;
  const entry = _markers[id];
  const jenis = entry?.data?.jenis || "laporan";
  if (!confirm(`Hapus laporan "${jenis}" ini dari peta semua pengguna?\nTindakan ini tidak dapat dibatalkan.`)) return;
  try {
    await db.collection("laporan").doc(id).delete();
    _showToast(`🗑️ Laporan "${jenis}" berhasil dihapus`, "ok");
  } catch (err) {
    console.error("[Admin] Delete error:", err);
    _showToast("❌ Gagal menghapus laporan", "err");
  }
}

/* =====================================================================
 * PUBLIC API — expose ke window agar bisa dipanggil dari HTML onclick
 * ===================================================================== */
window.initLaporan       = initLaporan;
window.openLaporanModal  = openLaporanModal;
window.closeLaporanModal = closeLaporanModal;
window.startMapPick      = startMapPick;
window.cancelMapPick     = cancelMapPick;
window.useGPSForLaporan  = useGPSForLaporan;
window.submitLaporan     = submitLaporan;
window.flyToLaporan      = flyToLaporan;
/* Admin */
window.openAdminModal    = openAdminModal;
window.closeAdminModal   = closeAdminModal;
window.tryAdminLogin     = tryAdminLogin;
window.adminLogout       = adminLogout;
window.toggleAdminMode   = toggleAdminMode;
window.deleteLaporan     = deleteLaporan;
