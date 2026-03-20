// === GRAPHIQUES UPLOAD ===
// Fonctions de rendu de graphique canvas 2D (upload cumulatif par torrent)
// et modal graphique plein écran.

// État de la modal graphique
let chartModalHash    = null;
let chartModalPoints  = null;
let chartModalRange   = 'all';
let chartModalHoverAC = null;

/** Calcule un pas d'axe Y "propre" (1, 2 ou 5 × puissance de 10) donnant au plus 4 graduations.
 *  @param {number} maxVal - Valeur maximale à représenter sur l'axe */
function niceTick(maxVal) {
  if (maxVal <= 0) return 1;
  const raw = maxVal / 4;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const f of [1, 2, 5, 10]) { if (f * exp >= raw) return f * exp; }
  return exp * 10;
}

/** Réduit un tableau de points [timestamp, valeur] à maxPts entrées maximum par sous-échantillonnage.
 *  Conserve toujours le premier et le dernier point.
 *  @param {Array}  points - Points bruts
 *  @param {number} maxPts - Nombre maximum de points à retourner */
function downsamplePoints(points, maxPts) {
  if (points.length <= maxPts) return points;
  const result = [points[0]];
  const step = (points.length - 1) / (maxPts - 2);
  for (let i = 1; i < maxPts - 1; i++) result.push(points[Math.round(i * step)]);
  result.push(points[points.length - 1]);
  return result;
}

/** Formate une durée en minutes en chaîne lisible : "X min", "Xh Ymin", "Xj Yh". */
function fmtWindow(winMins) {
  if (winMins < 60) return `${winMins} minute${winMins > 1 ? 's' : ''}`;
  const h = Math.floor(winMins / 60), m = winMins % 60;
  if (h < 24) return `${h}h${m > 0 ? ` ${m}min` : ''}`;
  const d = Math.floor(h / 24), rh = h % 24;
  return `${d}j${rh > 0 ? ` ${rh}h` : ''}${m > 0 ? ` ${m}min` : ''}`;
}

/** Dessine le graphique d'upload cumulatif sur un canvas 2D.
 *  Retourne un état snapshot utilisé par attachChartHover().
 *  @param {HTMLCanvasElement} canvas
 *  @param {Array}             points      - Points [[timestamp, uploaded_bytes], ...]
 *  @param {number}            H           - Hauteur du canvas en pixels CSS
 *  @param {string|null}       [windowLabel] - Libellé de plage pour la légende */
function drawChartOnCanvas(canvas, points, H, windowLabel = null) {
  const base    = points[0][1];
  const rates   = points.map(([, u]) => Math.max(0, (u - base) / 1e6));
  const times   = points.map(([t]) => t);
  const totalMb = rates[rates.length - 1];
  const winMins = Math.max(1, Math.round((points[points.length-1][0] - points[0][0]) / 60));

  const dpr = window.devicePixelRatio || 1;
  const W   = (canvas.parentElement.clientWidth || 600);
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD = { top: 22, right: H > 150 ? 16 : 30, bottom: 34, left: 52 };
  const CW  = W - PAD.left - PAD.right;
  const CH  = H - PAD.top - PAD.bottom;
  const maxRate = Math.max(...rates, 0.1);
  const yStep   = niceTick(maxRate);
  const yMax    = Math.ceil(maxRate / yStep) * yStep;

  const isDark    = document.documentElement.dataset.theme === 'dark';
  const bg2       = isDark ? '#1c1c1f' : '#faf9f6';
  const textColor = isDark ? '#999'    : '#777';
  const gridColor = isDark ? '#2a2a2d' : '#ddddd8';
  const fillColor = isDark ? 'rgba(29,158,117,0.2)' : 'rgba(29,158,117,0.12)';
  const lineColor = '#1D9E75';

  ctx.fillStyle = bg2;
  ctx.fillRect(0, 0, W, H);
  ctx.font = '10px system-ui,sans-serif';

  // Grilles + labels Y
  const yTicks = Math.min(5, Math.ceil(yMax / yStep));
  for (let i = 0; i <= yTicks; i++) {
    const v = i * yStep;
    const y = PAD.top + CH - (v / yMax) * CH;
    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + CW, y); ctx.stroke();
    ctx.fillStyle = textColor; ctx.textAlign = 'right';
    ctx.fillText(v >= 1000 ? (v/1000).toFixed(1)+'G' : v >= 100 ? v.toFixed(0) : v.toFixed(1), PAD.left - 4, y + 3);
  }
  ctx.save(); ctx.translate(10, PAD.top + CH / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillStyle = textColor; ctx.fillText('MB', 0, 0); ctx.restore();

  // Labels axe X
  const tMin = times[0], tMax = times[times.length - 1];
  const spanMin = Math.round((tMax - tMin) / 60);
  const ivCandidates = [5, 10, 15, 20, 30, 60, 120, 240, 720, 1440, 4320, 10080, 43200];
  const tickIntervalMin = ivCandidates.find(iv => Math.floor(spanMin / iv) <= 5) || 43200;
  const firstTickTs = Math.ceil(tMin / (tickIntervalMin * 60)) * (tickIntervalMin * 60);
  ctx.fillStyle = textColor; ctx.textAlign = 'center';
  for (let ts = firstTickTs; ts <= tMax; ts += tickIntervalMin * 60) {
    const x  = PAD.left + ((ts - tMin) / (tMax - tMin)) * CW;
    const dd = new Date(ts * 1000);
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + CH); ctx.stroke();
    const lbl = tickIntervalMin >= 1440
      ? `${dd.getDate()}/${dd.getMonth()+1}`
      : String(dd.getHours()).padStart(2,'0') + ':' + String(dd.getMinutes()).padStart(2,'0');
    ctx.fillText(lbl, x, H - 6);
  }

  // Aire + ligne
  ctx.beginPath();
  rates.forEach((v, i) => {
    const x = PAD.left + (i / Math.max(rates.length - 1, 1)) * CW;
    const y = PAD.top + CH - (v / yMax) * CH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(PAD.left + CW, PAD.top + CH);
  ctx.lineTo(PAD.left, PAD.top + CH);
  ctx.closePath(); ctx.fillStyle = fillColor; ctx.fill();
  ctx.beginPath();
  rates.forEach((v, i) => {
    const x = PAD.left + (i / Math.max(rates.length - 1, 1)) * CW;
    const y = PAD.top + CH - (v / yMax) * CH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5; ctx.stroke();

  // Légende
  const totalStr = totalMb >= 1000 ? (totalMb/1000).toFixed(2)+' GB' : totalMb.toFixed(0)+' MB';
  ctx.fillStyle = textColor; ctx.textAlign = 'right'; ctx.font = '10px system-ui,sans-serif';
  ctx.fillText(`${totalStr} uploadés sur ${windowLabel || fmtWindow(winMins)}`, PAD.left + CW, PAD.top - 6);

  const snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { snapshot, ctx, PAD, CW, CH, rates, times, yMax, W, H, isDark, lineColor };
}

/** Attache les gestionnaires mousemove/mouseleave pour afficher un tooltip au survol.
 *  Utilise un AbortSignal pour pouvoir détacher proprement les handlers lors d'un re-rendu. */
function attachChartHover(canvas, state, signal) {
  const { snapshot, ctx, PAD, CW, CH, rates, times, yMax, W, isDark, lineColor } = state;
  function drawHover(mouseX) {
    const relX = mouseX - PAD.left;
    if (relX < 0 || relX > CW) return;
    const idx = Math.round((relX / CW) * (rates.length - 1));
    const px  = PAD.left + (idx / Math.max(rates.length - 1, 1)) * CW;
    const val = rates[idx];
    const py  = PAD.top + CH - (val / yMax) * CH;
    const dd  = new Date(times[idx] * 1000);
    const timeStr = String(dd.getHours()).padStart(2,'0') + ':' + String(dd.getMinutes()).padStart(2,'0');
    const valStr  = val >= 1000 ? (val/1000).toFixed(2)+' GB' : val.toFixed(1)+' MB';
    ctx.putImageData(snapshot, 0, 0);
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px, PAD.top); ctx.lineTo(px, PAD.top + CH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor; ctx.fill();
    ctx.strokeStyle = isDark ? '#1c1c1f' : '#faf9f6'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = '10px system-ui,sans-serif';
    const label = `${timeStr}  ${valStr}`;
    const tW = ctx.measureText(label).width + 12, tH = 18;
    let tx = px + 8;
    if (tx + tW > W - 4) tx = px - tW - 8;
    const ty = Math.max(PAD.top, py - tH / 2 - 1);
    ctx.fillStyle = isDark ? 'rgba(40,40,44,0.92)' : 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(tx, ty, tW, tH, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = isDark ? '#e5e5e7' : '#1c1c1f'; ctx.textAlign = 'left';
    ctx.fillText(label, tx + 6, ty + 12);
  }
  canvas.addEventListener('mousemove', e => {
    drawHover(e.clientX - canvas.getBoundingClientRect().left);
  }, { signal });
  canvas.addEventListener('mouseleave', () => ctx.putImageData(snapshot, 0, 0), { signal });
}

/** Charge l'historique d'upload d'un torrent et dessine le graphique sur le canvas inline.
 *  Filtre les données aux dernières 24h.
 *  @param {string}            hash   - Hash SHA1 du torrent
 *  @param {HTMLCanvasElement} canvas - Canvas de la chart-row */
async function renderUploadChart(hash, canvas) {
  const container = canvas.parentElement;
  try {
    const d = await fetch(BASE + '/api/upload-history/' + hash, { credentials: 'include' }).then(r => r.json());
    const allPoints = d.points || [];
    if (allPoints.length < 2) {
      container.innerHTML = '<div class="chart-empty">Collecte en cours… (données disponibles après 5 min)</div>';
      return;
    }
    if (canvas._hoverAC) { canvas._hoverAC.abort(); }
    const ac = new AbortController();
    canvas._hoverAC = ac;
    const cutoff = (allPoints.length ? allPoints[allPoints.length-1][0] : 0) - 86400;
    const windowed = allPoints.filter(([t]) => t >= cutoff);
    const state = drawChartOnCanvas(canvas, downsamplePoints(windowed.length >= 2 ? windowed : allPoints, 600), 150, '24h');
    attachChartHover(canvas, state, ac.signal);
  } catch {
    container.innerHTML = '<div class="chart-empty">Erreur chargement</div>';
  }
}

/** Filtre les points d'historique selon la plage temporelle sélectionnée dans la modal. */
function filterByRange(points, range) {
  if (range === 'all' || !points.length) return points;
  const secs = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
  const cutoff = points[points.length-1][0] - (secs[range] || 0);
  return points.filter(([t]) => t >= cutoff);
}

/** Re-dessine le graphique de la modal avec la plage temporelle courante (chartModalRange). */
function renderModalChart() {
  if (!chartModalPoints || chartModalPoints.length < 2) return;
  const filtered = filterByRange(chartModalPoints, chartModalRange);
  if (filtered.length < 2) return;
  if (chartModalHoverAC) { chartModalHoverAC.abort(); }
  chartModalHoverAC = new AbortController();
  const canvas = document.getElementById('chart-modal-canvas');
  const rangeLabels = { '1h':'1h', '6h':'6h', '24h':'24h', '7d':'7j', '30d':'30j' };
  const state  = drawChartOnCanvas(canvas, downsamplePoints(filtered, 1200), 360, rangeLabels[chartModalRange] || null);
  attachChartHover(canvas, state, chartModalHoverAC.signal);
}

/** Ouvre la modal graphique plein écran pour un torrent donné.
 *  @param {string} hash - Hash SHA1 du torrent */
async function openChartModal(hash) {
  chartModalHash  = hash;
  chartModalRange = 'all';
  document.getElementById('chart-modal-title').textContent = torrentDataMap.get(hash) || hash;
  document.querySelectorAll('#chart-modal .btn-range').forEach(b => {
    b.classList.toggle('active', b.dataset.range === 'all');
  });
  document.getElementById('chart-modal').classList.add('open');
  try {
    const d = await fetch(BASE + '/api/upload-history/' + hash, { credentials: 'include' }).then(r => r.json());
    chartModalPoints = d.points || [];
  } catch { chartModalPoints = []; }
  renderModalChart();
}

/** Ferme la modal graphique et annule les handlers hover en cours. */
function closeChartModal() {
  document.getElementById('chart-modal').classList.remove('open');
  if (chartModalHoverAC) { chartModalHoverAC.abort(); chartModalHoverAC = null; }
}
