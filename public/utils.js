// === CONFIG ===
/** Préfixe de toutes les routes API — doit correspondre au mountPath Express */
const BASE = '/seedash';

// === UTILS ===

/** Échappe les caractères HTML spéciaux (&, <, >, ", ') pour sécuriser l'interpolation dans innerHTML. */
function he(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Formate un nombre d'octets en chaîne lisible (KB, MB, GB, TB). Retourne '—' si absent. */
function fmtBytes(b) {
  if (!b) return '—';
  if (b >= 1e12) return (b / 1e12).toFixed(1) + ' TB';
  if (b >= 1e9)  return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6)  return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}

/** Formate une vitesse en octets/seconde en KB/s ou MB/s. Retourne '—' si nulle. */
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
  return bps + ' B/s';
}

/** Convertit un nombre de secondes en chaîne "Xj Yh" ou "Zh". */
function fmtSecs(s) {
  if (!s) return '0h';
  const h = Math.floor(s / 3600);
  if (h >= 24) return Math.floor(h / 24) + 'j ' + (h % 24) + 'h';
  return h + 'h';
}

/** Calcule et formate l'âge d'un torrent à partir de son timestamp d'ajout Unix (added_on). */
function fmtAge(added_on) {
  if (!added_on) return '—';
  const secs = Math.floor(Date.now() / 1000) - added_on;
  return fmtSecs(secs);
}

/** Formate une date ISO en "JJ/MM/AAAA HH:MM" selon la locale fr-FR. */
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Formate une date ISO en deux spans HTML empilés (date / heure) pour l'affichage dans l'historique. */
function fmtDateStack(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `<span class="hist-date-day">${d.toLocaleDateString('fr-FR')}</span><span class="hist-date-time">${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>`;
}

/** Affiche temporairement un message dans un élément DOM (fade-in puis fade-out après 2,5 s). */
function showMsg(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  if (text !== undefined) el.textContent = text;
  el.style.opacity = 1;
  setTimeout(() => el.style.opacity = 0, 2500);
}

// === TOAST ===
let toastTimer = null;
/** Affiche une notification temporaire (toast) en bas de l'écran. Un seul toast à la fois. */
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast toast-${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), type === 'error' ? 7000 : 3500);
}

// === CATÉGORIES ===
/** Noms des catégories C411 : id numérique → libellé lisible */
const CAT_NAMES = {
  1000: 'Consoles', 2030: 'Films', 2050: 'Vidéo-clips', 2060: 'Animé (film)',
  2070: 'Documentaires', 2080: 'Spectacles', 2090: 'Concerts', 3010: 'Musique',
  3030: 'Audiobooks', 4000: 'PC / Apps', 4050: 'Jeux PC', 5000: 'Séries TV',
  5060: 'Sport', 5070: 'Animé (série)', 5080: 'Émissions TV', 6000: 'XXX',
  6010: 'Érotisme', 7010: 'Presse', 7020: 'Livres', 7030: 'BD / Comics / Manga',
  8010: 'Impression 3D',
};

// ledState, setLed, loadConnections, updateQbitStats, loadStats → stats.js
