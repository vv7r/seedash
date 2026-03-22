'use strict';
// === GRAPHIQUES UPLOAD ===
// Fonctions de rendu de graphique canvas 2D (upload cumulatif par torrent)
// et modal graphique plein écran.

// État de la modal graphique
let chartModalHash    = null;
let chartModalPoints  = null;
let chartModalHoverAC = null;

// État du brush (sélection temporelle)
let brushStart = 0;   // ratio 0-1
let brushEnd   = 1;   // ratio 0-1
let brushDragMode = null; // 'left' | 'right' | 'pan' | null
let brushDragStartX = 0;
let brushDragStartBS = 0;
let brushDragStartBE = 0;
let brushCleanup = null;  // fonction de nettoyage des listeners

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

  const cs        = getComputedStyle(document.documentElement);
  const v         = n => cs.getPropertyValue(n).trim();
  const bg2       = v('--chart-bg');
  const textColor = v('--chart-text');
  const gridColor = v('--chart-grid');
  const fillColor = v('--chart-fill');
  const lineColor = v('--chart-line');

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
    ctx.strokeStyle = v('--chart-grid-v');
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
  const hoverLine   = v('--chart-hover-line');
  const hoverBg     = v('--chart-hover-bg');
  const hoverBorder = v('--chart-hover-border');
  const hoverText   = v('--chart-hover-text');
  return { snapshot, ctx, PAD, CW, CH, rates, times, yMax, W, H, lineColor, bg2, hoverLine, hoverBg, hoverBorder, hoverText };
}

/** Attache les gestionnaires mousemove/mouseleave pour afficher un tooltip au survol.
 *  Utilise un AbortSignal pour pouvoir détacher proprement les handlers lors d'un re-rendu. */
function attachChartHover(canvas, state, signal) {
  const { snapshot, ctx, PAD, CW, CH, rates, times, yMax, W, lineColor, bg2, hoverLine, hoverBg, hoverBorder, hoverText } = state;
  function drawHover(mouseX) {
    const relX = mouseX - PAD.left;
    if (relX < 0 || relX > CW) return;
    const idx = Math.round((relX / CW) * (rates.length - 1));
    const px  = PAD.left + (idx / Math.max(rates.length - 1, 1)) * CW;
    const val = rates[idx];
    const py  = PAD.top + CH - (val / yMax) * CH;
    const dd  = new Date(times[idx] * 1000);
    const timeStr = String(dd.getDate()).padStart(2,'0') + '/' + String(dd.getMonth()+1).padStart(2,'0') + ' ' + String(dd.getHours()).padStart(2,'0') + ':' + String(dd.getMinutes()).padStart(2,'0');
    const valStr  = val >= 1000 ? (val/1000).toFixed(2)+' GB' : val.toFixed(1)+' MB';
    ctx.putImageData(snapshot, 0, 0);
    ctx.strokeStyle = hoverLine;
    ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px, PAD.top); ctx.lineTo(px, PAD.top + CH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor; ctx.fill();
    ctx.strokeStyle = bg2; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = '10px system-ui,sans-serif';
    const tW = Math.max(ctx.measureText(timeStr).width, ctx.measureText(valStr).width) + 12;
    const tH = 32;
    let tx = px + 8;
    if (tx + tW > W - 4) tx = px - tW - 8;
    const ty = Math.max(PAD.top, py - tH / 2 - 1);
    ctx.fillStyle = hoverBg;
    ctx.strokeStyle = hoverBorder;
    ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(tx, ty, tW, tH, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = hoverText; ctx.textAlign = 'left';
    ctx.fillText(timeStr, tx + 6, ty + 12);
    ctx.fillText(valStr, tx + 6, ty + 25);
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
    const d = await fetchT(BASE + '/api/upload-history/' + hash, { credentials: 'include' }).then(r => r.json());
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

/** Slice les points selon brushStart/brushEnd (ratios 0-1 sur l'index). */
function sliceByBrush(points) {
  if (!points.length) return points;
  const s = Math.floor(brushStart * (points.length - 1));
  const e = Math.ceil(brushEnd * (points.length - 1));
  return points.slice(s, e + 1);
}

/** Re-dessine le graphique principal de la modal avec la sélection brush courante. */
function renderModalChart() {
  if (!chartModalPoints || chartModalPoints.length < 2) return;
  const sliced = sliceByBrush(chartModalPoints);
  if (sliced.length < 2) return;
  if (chartModalHoverAC) { chartModalHoverAC.abort(); }
  chartModalHoverAC = new AbortController();
  const canvas = document.getElementById('chart-modal-canvas');
  const state  = drawChartOnCanvas(canvas, downsamplePoints(sliced, 1200), 360);
  attachChartHover(canvas, state, chartModalHoverAC.signal);
  drawBrush();
}

/** Dessine la mini-courbe d'overview avec la zone de sélection brush. */
function drawBrush() {
  const canvas = document.getElementById('chart-modal-brush');
  if (!canvas || !chartModalPoints || chartModalPoints.length < 2) return;
  const pts = downsamplePoints(chartModalPoints, 800);
  const base  = pts[0][1];
  const rates = pts.map(([, u]) => Math.max(0, (u - base) / 1e6));
  const maxR  = Math.max(...rates, 0.1);

  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement.clientWidth || 600;
  const H   = 50;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cs     = getComputedStyle(document.documentElement);
  const bv     = n => cs.getPropertyValue(n).trim();
  const bg     = bv('--chart-bg');
  const dimBg  = bv('--brush-dim');
  const line   = bv('--brush-line');
  const fill   = bv('--brush-fill');
  const handle = bv('--brush-handle');
  const selBorder = bv('--brush-border');

  const PAD = 4;
  const CW = W;
  const CH = H - PAD * 2;

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Mini courbe (area + line)
  ctx.beginPath();
  rates.forEach((v, i) => {
    const x = (i / Math.max(rates.length - 1, 1)) * CW;
    const y = PAD + CH - (v / maxR) * CH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(CW, PAD + CH);
  ctx.lineTo(0, PAD + CH);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  rates.forEach((v, i) => {
    const x = (i / Math.max(rates.length - 1, 1)) * CW;
    const y = PAD + CH - (v / maxR) * CH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Overlay sombre sur les zones non sélectionnées
  const lx = brushStart * CW;
  const rx = brushEnd * CW;
  ctx.fillStyle = dimBg;
  if (lx > 0) ctx.fillRect(0, 0, lx, H);
  if (rx < CW) ctx.fillRect(rx, 0, CW - rx, H);

  // Bordures de la sélection
  ctx.strokeStyle = selBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(lx, 0, rx - lx, H);

  // Poignées (barres verticales)
  ctx.fillStyle = handle;
  const hw = 14;
  ctx.fillRect(lx - hw / 2, 0, hw, H);
  ctx.fillRect(rx - hw / 2, 0, hw, H);

  // Grips (2 lignes espacées au centre des poignées)
  const gripH = 16, gripY = (H - gripH) / 2;
  ctx.fillStyle = bv('--brush-grip');
  for (const gx of [lx, rx]) {
    ctx.fillRect(gx - 2.5, gripY, 1, gripH);
    ctx.fillRect(gx + 1.5, gripY, 1, gripH);
  }
}

/** Attache les événements drag sur le brush canvas. */
function attachBrushEvents() {
  if (brushCleanup) { brushCleanup(); brushCleanup = null; }
  const canvas = document.getElementById('chart-modal-brush');
  if (!canvas) return;

  const MIN_SPAN = 0.03; // minimum 3% de sélection

  function getX(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function updateCursor(e) {
    const x = getX(e);
    const HANDLE = 0.01;
    if (Math.abs(x - brushStart) < HANDLE || Math.abs(x - brushEnd) < HANDLE) {
      canvas.style.cursor = 'ew-resize';
    } else if (x > brushStart && x < brushEnd) {
      canvas.style.cursor = brushDragMode ? 'grabbing' : 'grab';
    } else {
      canvas.style.cursor = 'crosshair';
    }
  }

  function onDown(e) {
    e.preventDefault();
    const x = getX(e);
    const HANDLE = 0.01;
    if (Math.abs(x - brushStart) < HANDLE) brushDragMode = 'left';
    else if (Math.abs(x - brushEnd) < HANDLE) brushDragMode = 'right';
    else if (x > brushStart && x < brushEnd) brushDragMode = 'pan';
    else {
      const span = brushEnd - brushStart;
      brushStart = Math.max(0, x - span / 2);
      brushEnd = Math.min(1, brushStart + span);
      if (brushEnd > 1) { brushEnd = 1; brushStart = Math.max(0, 1 - span); }
      brushDragMode = 'pan';
    }
    brushDragStartX  = x;
    brushDragStartBS = brushStart;
    brushDragStartBE = brushEnd;
    canvas.style.cursor = brushDragMode === 'pan' ? 'grabbing' : 'ew-resize';
  }

  function onMove(e) {
    if (!brushDragMode) { updateCursor(e); return; }
    e.preventDefault();
    const x = getX(e);
    const dx = x - brushDragStartX;

    if (brushDragMode === 'left') {
      brushStart = Math.max(0, Math.min(brushEnd - MIN_SPAN, brushDragStartBS + dx));
    } else if (brushDragMode === 'right') {
      brushEnd = Math.min(1, Math.max(brushStart + MIN_SPAN, brushDragStartBE + dx));
    } else if (brushDragMode === 'pan') {
      const span = brushDragStartBE - brushDragStartBS;
      let ns = brushDragStartBS + dx;
      let ne = brushDragStartBE + dx;
      if (ns < 0) { ns = 0; ne = span; }
      if (ne > 1) { ne = 1; ns = 1 - span; }
      brushStart = ns;
      brushEnd = ne;
    }
    drawBrush();
    renderModalChart();
  }

  function onUp() {
    brushDragMode = null;
    canvas.style.cursor = 'grab';
  }

  function onReset(e) {
    e.preventDefault();
    brushStart = 0;
    brushEnd = 1;
    renderModalChart();
  }

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('touchstart', onDown, { passive: false });
  canvas.addEventListener('dblclick', onReset);
  canvas.addEventListener('contextmenu', onReset);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchend', onUp);
  canvas.addEventListener('mousemove', updateCursor);

  brushCleanup = () => {
    canvas.removeEventListener('mousedown', onDown);
    canvas.removeEventListener('touchstart', onDown);
    canvas.removeEventListener('dblclick', onReset);
    canvas.removeEventListener('contextmenu', onReset);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchend', onUp);
    canvas.removeEventListener('mousemove', updateCursor);
  };
}

/** Ouvre la modal graphique plein écran pour un torrent donné.
 *  @param {string} hash - Hash SHA1 du torrent
 *  @param {string} [name] - Nom du torrent (optionnel, pour les torrents supprimés) */
async function openChartModal(hash, name) {
  chartModalHash = hash;
  brushStart = 0;
  brushEnd   = 1;
  document.getElementById('chart-modal-title').textContent = name || torrentDataMap.get(hash) || hash;
  document.getElementById('chart-modal').classList.add('open');
  try {
    const d = await fetchT(BASE + '/api/upload-history/' + hash, { credentials: 'include' }).then(r => r.json());
    chartModalPoints = d.points || [];
  } catch { chartModalPoints = []; }
  attachBrushEvents();
  renderModalChart();
}

/** Ferme la modal graphique et annule les handlers hover/brush en cours. */
function closeChartModal() {
  document.getElementById('chart-modal').classList.remove('open');
  if (chartModalHoverAC) { chartModalHoverAC.abort(); chartModalHoverAC = null; }
  if (brushCleanup) { brushCleanup(); brushCleanup = null; }
}
