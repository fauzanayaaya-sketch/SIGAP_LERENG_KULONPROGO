/* =====================================================================
 * SIGAP LERENG — script.js
 * WebGIS Kerawanan Longsor Kulon Progo
 * ===================================================================== */
"use strict";

/* ---------- Konfigurasi ---------- */
const DATA = {
  batas: "geojson/batas_administrasi.geojson",
  zona:      "geojson/zona_kerawanan_longsor.geojson",
  pemukiman: "geojson/pemukiman_terdampak.geojson",
  evakuasi:  "geojson/lokasi_evakuasi.geojson",
};

const COLOR = {
  rawan: {
    "Sangat Aman": "#1a9850",
    "Aman":      "#91cf60",
    "Sedang":      "#fee08b",
    "Rawan":  "#fc8d59",
    "Sangat Rawan":"#d73027",
  },
  dampak: {
    "Sangat Rendah": "#2c7fb8",
    "Rendah":"#7fcdbb",
    "Sedang":        "#fdae61",
    "Tinggi":        "#f46d43",
    "Sangat Tinggi": "#a50026",
  },
  reko: { "Baik": "#16a34a", "Cukup": "#eab308" },
  batas: "#ef4444",
  evac: "#38bdf8",
  route: "#f97316",
};

const CENTER = [-7.79, 110.19];

/* ---------- State ---------- */
let map;
let canvasRenderer = null;
const layers = {};
const counts = {};
const basemaps = {};
let evacFeatures = [];   // {name, lat, lng, props}
let zonaFeatures = [];   // raw GeoJSON features zona (untuk hover point-in-polygon)
let userMarker = null;
let routeLine = null;
let userLatLng = null;

/* ---------- Util ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
function fmt(n, d = 2) {
  const v = Number(n);
  if (isNaN(v)) return n ?? "-";
  return v.toLocaleString("id-ID", { maximumFractionDigits: d });
}
function safe(v) { return (v === null || v === undefined || v === "") ? "-" : v; }

/* Jarak haversine (km) */
function haversine(a, b) {
  const R = 6371;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLng = (b[1] - a[1]) * Math.PI / 180;
  const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
}

/* =====================================================================
 * SAFEGUARD PROYEKSI
 * Data target WGS84 (derajat). Jika ada file yang masih UTM 49S
 * (nilai ratusan ribu), reproyeksi otomatis di sisi klien via proj4.
 * ===================================================================== */
const UTM49S = "+proj=utm +zone=49 +south +datum=WGS84 +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

function looksLikeUTM(geojson) {
  const f = (geojson.features || []).find((x) => x.geometry);
  if (!f) return false;
  let c = f.geometry.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  // c sekarang [x, y]; UTM punya |x| > 180
  return Array.isArray(c) && Math.abs(c[0]) > 180;
}

function reprojectCoords(coords) {
  if (typeof coords[0] === "number") {
    const r = proj4(UTM49S, WGS84, [coords[0], coords[1]]);
    return [r[0], r[1]];
  }
  return coords.map(reprojectCoords);
}

function ensureWGS84(geojson) {
  if (typeof proj4 !== "undefined" && looksLikeUTM(geojson)) {
    for (const ft of geojson.features) {
   if (ft.geometry) ft.geometry.coordinates = reprojectCoords(ft.geometry.coordinates);
    }
    if (geojson.crs) delete geojson.crs;
  }
  return geojson;
}

/* =====================================================================
 * 1. INISIALISASI PETA + BASEMAP
 * ===================================================================== */
function initMap() {
  map = L.map("map", {
    center: CENTER,
    zoom: 11,
    zoomControl: true,
    preferCanvas: true,     // render vektor via Canvas: jauh lebih ringan
  });
  canvasRenderer = L.canvas({ padding: 0.5 });

  basemaps.dark = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { maxZoom: 19, attribution: "&copy; OpenStreetMap, &copy; CARTO" }
  );
  basemaps.osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }
  );
  basemaps.satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles &copy; Esri" }
  );
  basemaps.terrain = L.tileLayer(
    "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    { maxZoom: 17, attribution: "&copy; OpenTopoMap (CC-BY-SA)" }
  );

  basemaps.dark.addTo(map);
  L.control.scale({ position: "bottomright", imperial: false }).addTo(map);

  // Hover keterangan zona kerawanan (point-in-polygon, level peta)
  map.on("mousemove", onMapMoveZona);
  map.on("mouseout", hideZonaTip);
}

function switchBasemap(key) {
  Object.values(basemaps).forEach((b) => map.removeLayer(b));
  (basemaps[key] || basemaps.dark).addTo(map);
}

/* =====================================================================
 * 2. STYLE
 * ===================================================================== */
function styleZona(f) {
  return { stroke: false, weight: 0, fillColor: COLOR.rawan[f.properties.KLS_RAWAN] || "#888", fillOpacity: 0.55 };
}
function stylePemukiman(f) {
  return { stroke: false, weight: 0, fillColor: COLOR.dampak[f.properties.kls_damp] || "#888", fillOpacity: 0.6 };
}
const styleBatas = { color: COLOR.batas, weight: 2.5, opacity: 0.9, dashArray: "6 4" };

function evacMarker(f, latlng) {
  return L.circleMarker(latlng, {
  radius: 7, color: "#fff", weight: 1.5,
    fillColor: COLOR.reko[f.properties.kelas_reko] || COLOR.evac, fillOpacity: 0.95,
  });
}

/* =====================================================================
 * 3. POPUP & INTERAKSI
 * ===================================================================== */
const row = (l, v) => `<div class="popup-row"><span>${l}</span><span>${v}</span></div>`;
const badge = (t, c) => {
  // teks adaptif: gelap di atas abu terang, terang di atas abu gelap
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(c).trim());
  let fg = "#111111";
  if (m) {
    const lum = 0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16);
    fg = lum < 140 ? "#f5f5f5" : "#111111";
  }
  return `<span class="badge" style="background:${c};color:${fg}">${t}</span>`;
};

function popupHTML(kind, p) {
  if (kind === "zona") {
    return `<div class="popup-title">Zona Kerawanan Longsor</div>` +
      row("Kelas", badge(safe(p.KLS_RAWAN), COLOR.rawan[p.KLS_RAWAN] || "#888")) +
   row("Luas", fmt(p.Shape_Area, 0) + " m&sup2;") +
      row("Keliling", fmt(p.Shape_Leng, 0) + " m");
  }
  if (kind === "pemukiman") {
  return `<div class="popup-title">Pemukiman Terdampak</div>` +
      row("Tingkat Dampak", badge(safe(p.kls_damp), COLOR.dampak[p.kls_damp] || "#888"));
  }
  if (kind === "batas") {
    return `<div class="popup-title">Batas Administrasi</div>` +
 row("OBJECTID", safe(p.OBJECTID)) + row("Panjang", fmt(p.Shape_Leng, 4));
  }
  if (kind === "evakuasi") {
 const lat = Number(p.latitude), lng = Number(p.longitude);
    return `<div class="popup-title">LOKASI EVAKUASI</div>` +
      row("Rekomendasi", badge(safe(p.kelas_reko), COLOR.reko[p.kelas_reko] || "#888")) +
  row("Skor Total", fmt(p.skor_total)) +
      row("Kapasitas", fmt(p.jml_bangun, 0) + " jiwa") +
      `<div class="popup-actions">` +
      `<button class="popup-btn route" onclick="routeToEvac(${lat},${lng})">Rute</button>` +
      `<button class="popup-btn gmaps" onclick="openGmaps(${lat},${lng})">Google Maps</button>` +
  `</div>`;
  }
  return "";
}

/* =====================================================================
 * HOVER ZONA — point-in-polygon di level peta (andal walau ada layer
 * lain di atasnya & ringan untuk Canvas). Zona dibuat non-interactive.
 * ===================================================================== */
let zonaTip = null;

// ray-casting: titik [lng,lat] di dalam satu ring?
function pointInRing(pt, ring) {
  let inside = false;
  const x = pt[0], y = pt[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
  const xj = ring[j][0], yj = ring[j][1];
const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// di dalam polygon (cek ring luar, kurangi lubang)
function pointInPolygon(pt, polygon) {
  if (!polygon.length || !pointInRing(pt, polygon[0])) return false;
  for (let h = 1; h < polygon.length; h++) {
    if (pointInRing(pt, polygon[h])) return false; // dalam lubang
  }
  return true;
}

function pointInGeometry(pt, geom) {
  if (geom.type === "Polygon") return pointInPolygon(pt, geom.coordinates);
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.some((poly) => pointInPolygon(pt, poly));
  }
  return false;
}

function zonaAt(latlng) {
  const pt = [latlng.lng, latlng.lat];
  for (const f of zonaFeatures) {
    if (pointInGeometry(pt, f.geometry)) return f.properties.KLS_RAWAN;
  }
  return null;
}

function onMapMoveZona(e) {
  if (!layers.zona || !map.hasLayer(layers.zona) || !zonaFeatures.length) {
    hideZonaTip();
    return;
  }
  const kelas = zonaAt(e.latlng);
  if (kelas == null) { hideZonaTip(); return; }
  if (!zonaTip) {
    zonaTip = L.tooltip({ direction: "top", className: "zona-tip", opacity: 1, offset: [0, -6] });
  }
  zonaTip.setLatLng(e.latlng).setContent(`<b>Kerawanan: ${safe(kelas)}</b>`);
  if (!map.hasLayer(zonaTip)) zonaTip.addTo(map);
}

function hideZonaTip() {
  if (zonaTip && map.hasLayer(zonaTip)) map.removeLayer(zonaTip);
}

function interaction(kind) {
  return (feature, layer) => {
    layer.bindPopup(popupHTML(kind, feature.properties), { maxWidth: 280 });
    if (kind !== "evakuasi") {
 layer.on({
   mouseover: (e) => e.target.setStyle({ fillOpacity: 0.85 }),
        mouseout: (e) => layers[kind].resetStyle(e.target),
    });
    } else {
      layer.on({
  mouseover: (e) => e.target.setStyle({ radius: 10 }),
  mouseout: (e) => e.target.setStyle({ radius: 7 }),
      });
 }
  };
}

/* =====================================================================
 * 4. LOAD GEOJSON
 * ===================================================================== */
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal memuat ${url} (HTTP ${res.status})`);
  return res.json();
}

async function loadData() {
  const steps = [
    ["batas", DATA.batas], ["zona", DATA.zona],
    ["pemukiman", DATA.pemukiman], ["evakuasi", DATA.evakuasi],
  ];

  for (const [key, url] of steps) {
    try {
      const gj = ensureWGS84(await fetchJSON(url));
      counts[key] = (gj.features || []).length;

      if (key === "zona") {
  layers.zona = L.geoJSON(gj, { renderer: canvasRenderer, style: styleZona, interactive: false });
        zonaFeatures = (gj.features || []).filter((f) => f.geometry);
      } else if (key === "pemukiman") {
    layers.pemukiman = L.geoJSON(gj, { renderer: canvasRenderer, style: stylePemukiman, onEachFeature: interaction("pemukiman") });
      } else if (key === "batas") {
 layers.batas = L.geoJSON(gj, { renderer: canvasRenderer, style: styleBatas, onEachFeature: interaction("batas") });
      } else if (key === "evakuasi") {
   layers.evakuasi = L.geoJSON(gj, { renderer: canvasRenderer, pointToLayer: evacMarker, onEachFeature: interaction("evakuasi") });
        // simpan daftar untuk pencarian + rute
    gj.features.forEach((ft) => {
          if (ft.geometry && ft.geometry.type === "Point") {
    const [lng, lat] = ft.geometry.coordinates;
      evacFeatures.push({
          name: ft.properties.nama_sumbe || ft.properties.nama_titik || ft.properties.id_evakuas,
            lat, lng, props: ft.properties,
        });
          }
        });
      }
    } catch (err) {
      console.error(err);
      counts[key] = 0;
    }
  }

  ["zona", "pemukiman", "batas", "evakuasi"].forEach((k) => { if (layers[k]) layers[k].addTo(map); });
  fitData();
}

function fitData() {
  const grp = L.featureGroup(
    ["zona", "pemukiman", "batas", "evakuasi"].map((k) => layers[k]).filter(Boolean)
  );
  if (grp.getLayers().length) map.fitBounds(grp.getBounds(), { padding: [30, 30] });
}

/* Fokus ke seluruh area rawan bencana (zona kerawanan) */
function fitHazard(animate) {
  const target = layers.zona || layers.pemukiman;
  if (!target) { fitData(); return; }
  map.fitBounds(target.getBounds(), {
padding: [50, 50],
    maxZoom: 12,
    animate: !!animate,
  });
}

/* =====================================================================
 * 5. KONTROL LAYER + STATISTIK
 * ===================================================================== */
const LAYER_META = [
  { key: "evakuasi",  name: "Lokasi Evakuasi", sw: COLOR.evac },
  { key: "batas",     name: "Batas Administrasi", sw: COLOR.batas },
  { key: "pemukiman", name: "Pemukiman Terdampak", sw: "#f46d43" },
  { key: "zona",    name: "Zona Kerawanan Longsor", sw: "#fc8d59" },
];

function buildLayerControl() {
  const box = $("#layerControl");
  box.innerHTML = "";
  LAYER_META.forEach((m) => {
    if (!layers[m.key]) return;
    const row = document.createElement("label");
    row.className = "layer-item";
  row.innerHTML =
   `<input type="checkbox" checked />` +
  `<span class="sw on"></span>` +
 `<span class="nm">${m.name}</span>`;
    const sw = row.querySelector(".sw");
    row.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) { layers[m.key].addTo(map); sw.classList.add("on"); }
      else { map.removeLayer(layers[m.key]); sw.classList.remove("on"); }
    });
    box.appendChild(row);
  });
}

function updateStats() {
  $("#homeZonaCount").textContent = counts.zona ?? 0;
  $("#homeBatasCount").textContent = counts.batas ?? 0;
  $("#homeEvakuasiCount").textContent = counts.evakuasi ?? 0;
  $("#homePemukimanCount").textContent = counts.pemukiman ?? 0;
}

/* =====================================================================
 * 6. PENCARIAN + SARAN
 * ===================================================================== */
function renderSuggestions(q) {
  const ul = $("#searchSuggestions");
  const term = q.trim().toLowerCase();
  if (!term) { ul.hidden = true; ul.innerHTML = ""; return; }
  const hits = evacFeatures
 .filter((e) => (e.name || "").toLowerCase().includes(term))
    .slice(0, 8);
  if (!hits.length) { ul.hidden = true; ul.innerHTML = ""; return; }
  ul.innerHTML = hits
    .map((h) => `<li data-lat="${h.lat}" data-lng="${h.lng}">${h.name}<small>${safe(h.props.kelas_reko)} • skor ${fmt(h.props.skor_total)}</small></li>`)
    .join("");
  ul.hidden = false;
  ul.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", () => {
      flyTo(+li.dataset.lat, +li.dataset.lng);
      $("#searchInput").value = li.textContent.split("\n")[0];
ul.hidden = true;
    });
  });
}

function doSearch() {
  const term = $("#searchInput").value.trim().toLowerCase();
  if (!term) return;
  const hit = evacFeatures.find((e) => (e.name || "").toLowerCase().includes(term));
  if (hit) flyTo(hit.lat, hit.lng);
  else setStatus("Tidak ditemukan", `"${$("#searchInput").value}" tidak cocok dengan data.`, false);
  $("#searchSuggestions").hidden = true;
}

function flyTo(lat, lng) {
  map.flyTo([lat, lng], 15, { duration: 0.8 });
  L.popup().setLatLng([lat, lng]).setContent("<b>Lokasi dipilih</b>").openOn(map);
}

/* =====================================================================
 * 7. GEOLOKASI + RUTE EVAKUASI TERDEKAT
 * ===================================================================== */
function locateUser(then) {
  if (!navigator.geolocation) {
    setStatus("Geolokasi tidak didukung", "Browser tidak mendukung deteksi lokasi.", false);
    return;
  }
  setStatus("Mendeteksi lokasi", "Mohon izinkan akses lokasi...", false);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLatLng = [pos.coords.latitude, pos.coords.longitude];
      if (userMarker) map.removeLayer(userMarker);
    userMarker = L.marker(userLatLng, {
        icon: L.divIcon({ className: "", html: '<div class="user-pin"></div>', iconSize: [18, 18] }),
      }).addTo(map).bindPopup("<b>Lokasi Anda</b>");
      map.flyTo(userLatLng, 14, { duration: 0.8 });
      $("#locationText").textContent =
        `Lokasi terdeteksi: ${userLatLng[0].toFixed(5)}, ${userLatLng[1].toFixed(5)}`;
      setStatus("Lokasi terdeteksi", "Posisi Anda ditandai di peta.", true);
      if (typeof then === "function") then();
    },
    () => setStatus("Gagal", "Tidak dapat mengakses lokasi. Cek izin browser.", false),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function routeToNearest() {
  const run = () => {
    if (!userLatLng || !evacFeatures.length) return;
    // Tentukan kandidat terdekat (garis lurus) untuk efisiensi.
    let best = null, bestD = Infinity;
    for (const e of evacFeatures) {
      const d = haversine(userLatLng, [e.lat, e.lng]);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) return;
    drawRouteTo(best);
  };
  if (userLatLng) run();
  else locateUser(run);
}

/* Gambar rute (mengikuti jalan via OSRM) dari user ke satu tujuan evakuasi.
 * dest = { lat, lng, name, props } */
async function drawRouteTo(dest) {
  if (!userLatLng) { locateUser(() => drawRouteTo(dest)); return; }

  const straightD = haversine(userLatLng, [dest.lat, dest.lng]);
  setStatus("Menghitung rute", "Mengambil jalur jalan dari OSRM...", false);

  // OSRM publik hanya punya profil mobil. Geometri jalan tetap dipakai
  // (motor & mobil berbagi jalan), waktu dihitung ulang dgn kecepatan motor.
  const MOTOR_KMH = 30;
  let coords = null, roadKm = null, durMin = null, viaRoad = false;
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${userLatLng[1]},${userLatLng[0]};${dest.lng},${dest.lat}` +
 `?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.routes && data.routes.length) {
      const r = data.routes[0];
     coords = r.geometry.coordinates.map((c) => [c[1], c[0]]); // [lat,lng]
        roadKm = r.distance / 1000;
        durMin = (roadKm / MOTOR_KMH) * 60;
        viaRoad = true;
      }
    }
  } catch (err) {
    console.warn("OSRM gagal, fallback garis lurus:", err);
  }

  if (!coords) coords = [userLatLng, [dest.lat, dest.lng]];

  if (routeLine) map.removeLayer(routeLine);
  routeLine = L.polyline(coords, {
    color: COLOR.route, weight: 5, opacity: 0.9, lineJoin: "round",
    dashArray: viaRoad ? null : "8 6",
  }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [60, 60] });

const distTxt = viaRoad ? fmt(roadKm, 2) + " km via jalan" : fmt(straightD, 2) + " km (garis lurus)";
  L.popup().setLatLng([dest.lat, dest.lng])
    .setContent(`<div class="popup-title">LOKASI EVAKUASI</div>` +
      row("Jarak", distTxt) +
      (viaRoad ? row("Estimasi motor", fmt(durMin, 0) + " menit") : "") +
    row("Rekomendasi", badge(safe(dest.props.kelas_reko), COLOR.reko[dest.props.kelas_reko] || "#888")) +
      `<button class="popup-btn gmaps" onclick="openGmaps(${dest.lat},${dest.lng})">Buka di Google Maps</button>`)
    .openOn(map);

  setStatus(
    viaRoad ? "Rute motor dibuat" : "Rute (garis lurus)",
    viaRoad
 ? `${dest.name} • ${fmt(roadKm, 2)} km • ~${fmt(durMin, 0)} mnt naik motor.`
      : `OSRM tak tersedia. ${dest.name} • ${fmt(straightD, 2)} km.`,
    true
  );
}

/* Dipanggil dari tombol di dalam popup */
function routeToEvac(lat, lng) {
  const dest = evacFeatures.find((e) => e.lat === lat && e.lng === lng) || { lat, lng, name: "Lokasi Evakuasi", props: {} };
  drawRouteTo(dest);
}

/* Buka rute di Google Maps. Pakai origin lokasi user bila ada. */
function openGmaps(lat, lng) {
  let url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  if (userLatLng) url += `&origin=${userLatLng[0]},${userLatLng[1]}`;
  window.open(url, "_blank", "noopener");
}

function clearRoute() {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  setStatus("Rute dihapus", "Garis rute dibersihkan dari peta.", true);
}

/* =====================================================================
 * 8. STATUS PANEL
 * ===================================================================== */
let statusTimer = null;
function setStatus(title, desc, done) {
  const el = $("#mapStatus");
  el.classList.remove("hide");
  el.classList.toggle("done", !!done);
  el.querySelector("strong").textContent = title;
  el.querySelector("span").textContent = desc;
  clearTimeout(statusTimer);
  if (done) statusTimer = setTimeout(() => el.classList.add("hide"), 4000);
}

/* =====================================================================
 * 9. NAVIGASI VIEW (Beranda / Peta)
 * ===================================================================== */
function showView(id) {
  $$(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  $$(".view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
  if (id === "mapView") {
setTimeout(() => {
      map.invalidateSize();
      fitHazard(true); // fokus ke seluruh area rawan bencana
    }, 250);
  }
}

/* =====================================================================
 * 10. WIRING UI
 * ===================================================================== */
function initUI() {
  // Tab + tombol lompat
  $$(".view-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $$("[data-view-jump]").forEach((b) =>
    b.addEventListener("click", () => showView(b.dataset.viewJump))
  );

  // Header locate
  $("#btnHeaderLocate").addEventListener("click", () => { showView("mapView"); locateUser(); });

  // Beranda: cari titik evakuasi sampel
  $("#btnHomeSearchSample").addEventListener("click", () => {
    showView("mapView");
    setTimeout(() => { $("#searchInput").focus(); }, 300);
  });

  // Pencarian
  $("#searchInput").addEventListener("input", (e) => renderSuggestions(e.target.value));
  $("#searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  $("#btnSearch").addEventListener("click", doSearch);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) $("#searchSuggestions").hidden = true;
  });

  // Lokasi & rute
  $("#btnLocate").addEventListener("click", () => locateUser());
  $("#btnNearestEvac").addEventListener("click", routeToNearest);
  $("#btnClearRoute").addEventListener("click", clearRoute);

  // Tampilan peta
  $("#btnResetView").addEventListener("click", () => map.flyTo(CENTER, 11, { duration: 0.8 }));
  $("#btnFitData").addEventListener("click", fitData);
  // Custom basemap dropdown
  const bsDropdown = $("#basemapDropdown");
  const bsTrigger  = $("#basemapTrigger");
  const bsMenu     = $("#basemapMenu");
  const bsLabel    = $("#basemapLabel");

  bsTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = bsDropdown.classList.toggle("open");
    bsMenu.hidden = !isOpen;
  });

  bsMenu.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", () => {
      // update selected state
      bsMenu.querySelectorAll("li").forEach((x) => x.classList.remove("selected"));
      li.classList.add("selected");
      // update trigger label + icon
      bsLabel.textContent = li.textContent;
      bsTrigger.querySelector(".basemap-icon").textContent = li.dataset.icon;
      // switch basemap
      switchBasemap(li.dataset.value);
      // close
      bsMenu.hidden = true;
      bsDropdown.classList.remove("open");
    });
  });

  // Set initial selected state
  bsMenu.querySelector("li[data-value='dark']").classList.add("selected");

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#basemapDropdown")) {
      bsMenu.hidden = true;
      bsDropdown.classList.remove("open");
    }
  });

  // Lipat sidebar
  $("#btnToggleSidebar").addEventListener("click", () => {
    $(".map-layout").classList.toggle("collapsed");
    setTimeout(() => map.invalidateSize(), 300);
  });
}

/* =====================================================================
 * 11. BOOTSTRAP
 * ===================================================================== */
async function main() {
  initMap();
  initUI();
  setStatus("Memuat data", "Membaca GeoJSON asli...", false);
  try {
    await loadData();
    buildLayerControl();
  updateStats();
    setStatus("Data siap", "Semua layer berhasil dimuat.", true);
  } catch (err) {
    console.error(err);
    setStatus("Gagal memuat", "Jalankan via server lokal & cek console.", false);
  }
}

document.addEventListener("DOMContentLoaded", main);
