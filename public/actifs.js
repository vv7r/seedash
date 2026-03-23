'use strict';
// === TORRENTS ACTIFS ===

// État local des torrents actifs
let actifsHashes = '';
let actifsSortKey = localStorage.getItem('actifs-sort-key') || null;
let actifsSortDir = parseInt(localStorage.getItem('actifs-sort-dir')) || 1;
let cleanerEnabled = true; // mis à jour par loadCleanerStatus (rules.js)

/**
 * Crée une ligne chart-row pour un torrent donné, la positionne après `afterElement`
 * et lance le rendu du graphique d'upload.
 * @param {string}      hash        - Hash du torrent
 * @param {HTMLElement} afterElement - Ligne de référence (insertAdjacentElement 'afterend')
 */
function insertChartRow(hash, afterElement) {
  const chartTr = document.createElement('tr');
  chartTr.className = 'chart-row'; chartTr.dataset.hash = hash;
  const td = document.createElement('td'); td.colSpan = 9;
  td.innerHTML = '<div class="chart-container"><button class="chart-expand-btn" data-action="expand-chart" data-hash="' + he(hash) + '" title="Agrandir">⤢</button><canvas class="upload-chart"></canvas></div>';
  chartTr.appendChild(td);
  afterElement.insertAdjacentElement('afterend', chartTr);
  renderUploadChart(hash, td.querySelector('canvas'));
}

/** Change la clé de tri des torrents actifs (inverse si même clé) et force un rebuild.
 *  @param {string} key - Clé de colonne */
function setActifsSort(key) {
  actifsSortDir = actifsSortKey === key ? actifsSortDir * -1 : 1;
  actifsSortKey = key;
  localStorage.setItem('actifs-sort-key', actifsSortKey);
  localStorage.setItem('actifs-sort-dir', actifsSortDir);
  actifsHashes = '';
  loadActifs();
}

/** Trie une liste de torrents selon actifsSortKey/actifsSortDir. */
function sortActifsData(torrents, ratioMin, seedMin, ratioOn, ageOn, uploadOn) {
  if (!actifsSortKey) return torrents;
  return [...torrents].sort((a, b) => {
    let va, vb;
    switch (actifsSortKey) {
      case 'name':     va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
      case 'size':     va = a.size;      vb = b.size;      break;
      case 'ratio':    va = a.ratio;     vb = b.ratio;     break;
      case 'added_on': va = a.added_on;  vb = b.added_on;  break;
      case 'dlspeed':  va = a.dlspeed;   vb = b.dlspeed;   break;
      case 'upspeed':  va = a.upspeed;   vb = b.upspeed;   break;
      case 'state':    va = a.state;     vb = b.state;     break;
      case 'status':   va = actifsCalc(a, ratioMin, seedMin, ratioOn, ageOn, uploadOn).canDel ? 1 : 0;
                       vb = actifsCalc(b, ratioMin, seedMin, ratioOn, ageOn, uploadOn).canDel ? 1 : 0; break;
      default: return 0;
    }
    if (va < vb) return -actifsSortDir;
    if (va > vb) return actifsSortDir;
    return 0;
  });
}

/** Reconstruit dynamiquement le <tr> d'en-tête du tableau des torrents actifs. */
function renderActifsHeaders() {
  const cols = [
    { key: 'state',    label: 'État',   cls: 'cell-status' },
    { key: 'name',     label: 'Nom',    cls: 'col-nom' },
    { key: 'size',     label: 'Taille', cls: 'col-size' },
    { key: 'ratio',    label: 'Ratio',  cls: '' },
    { key: 'added_on', label: 'Age',    cls: 'cell-seedtime' },
    { key: 'dlspeed',  label: 'DL',     cls: 'cell-dl' },
    { key: 'upspeed',  label: 'UP',     cls: 'cell-up' },
    { key: 'status',   label: 'Statut', cls: 'cell-label' },
    { key: null,       label: '',       cls: 'cell-action-th' },
  ];
  const tr = document.querySelector('#sec-actifs thead tr');
  if (!tr) return;
  tr.innerHTML = cols.map(c => {
    if (!c.key) return `<th${c.cls ? ` class="${c.cls}"` : ''}>${c.label}</th>`;
    const sortCls = actifsSortKey === c.key ? (actifsSortDir === 1 ? ' sort-asc' : ' sort-desc') : '';
    return `<th class="sortable${c.cls ? ' ' + c.cls : ''}${sortCls}" data-action="sort-actifs" data-key="${c.key}">${c.label}</th>`;
  }).join('');
}

/** Retourne le badge HTML coloré correspondant à l'état qBittorrent d'un torrent. */
function actifsStateBadge(t) {
  const pct = t.progress >= 1 ? 100 : Math.floor((t.progress || 0) * 100);
  switch (t.state) {
    case 'downloading': case 'forcedDL':
      return `<span class="badge badge-blue">DL ${pct}%</span>`;
    case 'metaDL':
      return `<span class="badge badge-blue">métadonnées</span>`;
    case 'allocating':
      return `<span class="badge badge-gray">allocation</span>`;
    case 'stalledDL':
      return `<span class="badge badge-amber">DL bloqué</span>`;
    case 'pausedDL':
      return `<span class="badge badge-gray">DL pausé</span>`;
    case 'queuedDL':
      return `<span class="badge badge-gray">DL en file</span>`;
    case 'uploading': case 'forcedUP':
      return `<span class="badge badge-green">upload ↑</span>`;
    case 'stalledUP':
      return `<span class="badge badge-gray">seed inactif</span>`;
    case 'pausedUP':
      return `<span class="badge badge-gray">seed pausé</span>`;
    case 'queuedUP':
      return `<span class="badge badge-gray">en file</span>`;
    case 'checkingDL': case 'checkingUP': case 'checkingResumeData':
      return `<span class="badge badge-gray">vérification</span>`;
    case 'moving':
      return `<span class="badge badge-gray">déplacement</span>`;
    case 'missingFiles':
      return `<span class="badge badge-amber">fichiers manquants</span>`;
    case 'error': case 'unknown':
      return `<span class="badge badge-amber">erreur</span>`;
    default:
      return t.progress < 1
        ? `<span class="badge badge-blue">DL ${pct}%</span>`
        : `<span class="badge badge-green">seed ✓</span>`;
  }
}

/** Calcule les indicateurs de suppression d'un torrent (logique miroir de cleaner.js).
 *  Toutes les conditions actives doivent être vraies simultanément (logique AND). */
function actifsCalc(t, ratioMin, seedMin, ratioOn, ageOn, uploadOn) {
  const ratioOk   = !ratioOn  || t.ratio >= ratioMin;
  const age       = Math.floor(Date.now() / 1000) - t.added_on;
  const timeOk    = !ageOn    || age >= seedMin;
  const uploadMet = !uploadOn || !!t.upload_condition;
  const anyOn  = ratioOn || ageOn || uploadOn;
  const canDel = cleanerEnabled && anyOn && ratioOk && timeOk && uploadMet;
  const displayMin = ratioOn && ratioMin > 0 ? ratioMin : 1.0;
  const pct        = Math.min(100, Math.round((t.ratio / displayMin) * 100));
  const ratioState = t.ratio >= displayMin ? 'ok' : (pct > 60 ? 'warn' : 'low');
  return { ratioOk, timeOk, canDel, pct, ratioState };
}

/** Génère le HTML complet d'une ligne torrent pour le tableau des actifs. */
function actifsRowHTML(t, ratioMin, seedMin, ratioOn, ageOn, uploadOn) {
  const { timeOk, canDel, pct, ratioState } = actifsCalc(t, ratioMin, seedMin, ratioOn, ageOn, uploadOn);
  torrentDataMap.set(t.hash, t.name);
  return `<tr data-hash="${t.hash}">
    <td class="cell-status">${actifsStateBadge(t)}</td>
    <td class="col-nom"><div class="td-name" title="${he(t.name)}"><a href="${c411Base}/torrents/${t.hash}" target="_blank" rel="noopener" class="td-link">${he(t.name)}</a></div></td>
    <td class="td-size col-size">${fmtBytes(t.size)}</td>
    <td class="cell-ratio-td ratio-state-${ratioState}"><div class="prog-wrap">
      <div class="prog-bar-bg"><div class="cell-ratio-bar prog-bar" data-pct="${pct}"></div></div>
      <span class="cell-ratio-val prog-val">${t.ratio.toFixed(2)}</span>
    </div></td>
    <td class="cell-seedtime${timeOk ? ' time-ok' : ''}" title="Seedtime : ${fmtSecs(t.seeding_time)}">${fmtAge(t.added_on)}</td>
    <td class="cell-dl">${fmtSpeed(t.dlspeed)}</td>
    <td class="cell-up">${fmtSpeed(t.upspeed)}</td>
    <td class="cell-label">${canDel ? `<span class="badge badge-amber">prêt à suppr.</span>` : `<span class="badge badge-gray">conservation</span>`}</td>
    <td class="cell-action"><span><button class="btn-del-x" data-action="delete-manual" data-hash="${t.hash}">✕</button></span></td>
  </tr>`;
}

/** Met à jour les cellules mutables d'une ligne existante sans reconstruire le DOM complet.
 *  Évite le flicker lors des rafraîchissements périodiques. */
function actifsUpdateRow(row, t, ratioMin, seedMin, ratioOn, ageOn, uploadOn) {
  const { timeOk, canDel, pct, ratioState } = actifsCalc(t, ratioMin, seedMin, ratioOn, ageOn, uploadOn);
  row.querySelector('.cell-status').innerHTML = actifsStateBadge(t);
  const bar = row.querySelector('.cell-ratio-bar');
  bar.style.width = pct + '%';
  row.querySelector('.cell-ratio-td').className = 'cell-ratio-td ratio-state-' + ratioState;
  row.querySelector('.cell-ratio-val').textContent = t.ratio.toFixed(2);
  const st = row.querySelector('.cell-seedtime');
  st.textContent = fmtAge(t.added_on);
  st.className = 'cell-seedtime' + (timeOk ? ' time-ok' : '');
  st.title = 'Seedtime : ' + fmtSecs(t.seeding_time);
  row.querySelector('.cell-dl').textContent = fmtSpeed(t.dlspeed);
  row.querySelector('.cell-up').textContent = fmtSpeed(t.upspeed);
  row.querySelector('.cell-label').innerHTML = canDel
    ? `<span class="badge badge-amber">prêt à suppr.</span>`
    : `<span class="badge badge-gray">conservation</span>`;
  torrentDataMap.set(t.hash, t.name);
  row.querySelector('.cell-action').innerHTML =
    `<span><button class="btn-del-x" data-action="delete-manual" data-hash="${t.hash}">✕</button></span>`;
}

/** Charge la liste des torrents actifs depuis /api/torrents et met à jour le tableau.
 *  - Rebuild complet si la liste de hashs change
 *  - Mise à jour incrémentale si la liste est identique → évite le flicker */
async function loadActifs() {
  const tbody = document.getElementById('actifs-body');
  try {
    const [tr, rr] = await Promise.all([
      fetchT(BASE + '/api/torrents', { credentials: 'include' }).then(r => { if (r.status === 401) { showLogin('Session expirée'); throw new Error('401'); } return r.json(); }),
      fetchT(BASE + '/api/rules', { credentials: 'include' }).then(r => r.json())
    ]);
    const torrents = tr.torrents || [];
    updateQbitStats(torrents);
    const ratioOn  = rr._on?.ratio_min     !== false;
    const ageOn    = rr._on?.age_min_hours !== false;
    const uploadOn = rr._on?.upload_min_mb !== false;
    const ratioMin = rr.ratio_min || 1.0;
    const seedMin  = (rr.age_min_hours || 48) * 3600;
    renderActifsHeaders();
    if (!torrents.length) {
      actifsHashes = '';
      tbody.innerHTML = `<tr><td colspan="9" class="tbl-empty">Aucun torrent actif</td></tr>`;
      return;
    }
    const catSel = document.getElementById('f-cat-actifs');
    const catCurrent = catSel.value;
    const cats = [...new Set(torrents.map(t => t.category).filter(Boolean))].sort((a, b) => a - b);
    catSel.innerHTML = '<option value="">Toutes</option>' +
      cats.map(c => `<option value="${he(c)}">${he(CAT_NAMES[c] || c)}</option>`).join('');
    if (catCurrent) catSel.value = catCurrent;
    const activeCat = catSel.value;
    const filtered = activeCat ? torrents.filter(t => t.category === activeCat) : torrents;
    const sorted = sortActifsData(filtered, ratioMin, seedMin, ratioOn, ageOn, uploadOn);
    const newHashes = sorted.map(t => t.hash).join(',') + '|' + actifsSortKey + actifsSortDir + '|' + activeCat;
    if (newHashes !== actifsHashes) {
      actifsHashes = newHashes;
      const savedChartRows = new Map();
      for (const hash of openChartHashes) {
        const existing = tbody.querySelector(`.chart-row[data-hash="${hash}"]`);
        if (existing) savedChartRows.set(hash, existing);
      }
      tbody.innerHTML = sorted.map(t => actifsRowHTML(t, ratioMin, seedMin, ratioOn, ageOn, uploadOn)).join('');
      tbody.querySelectorAll('.cell-ratio-bar[data-pct]').forEach(bar => { bar.style.width = bar.dataset.pct + '%'; });
      for (const hash of openChartHashes) {
        const dataRow = tbody.querySelector(`tr[data-hash="${hash}"]:not(.chart-row)`);
        if (!dataRow) { openChartHashes.delete(hash); continue; }
        if (savedChartRows.has(hash)) {
          dataRow.insertAdjacentElement('afterend', savedChartRows.get(hash));
        } else {
          insertChartRow(hash, dataRow);
        }
      }
    } else {
      for (const t of sorted) {
        const row = tbody.querySelector(`tr[data-hash="${t.hash}"]`);
        if (row) actifsUpdateRow(row, t, ratioMin, seedMin, ratioOn, ageOn, uploadOn);
      }
    }
  } catch (e) {
    actifsHashes = '';
    tbody.innerHTML = `<tr><td colspan="9" class="tbl-empty">Erreur API qBittorrent</td></tr>`;
  }
}

/** Supprime un torrent après confirmation via la modale générique. */
async function deleteTorrent(hash) {
  const name = torrentDataMap.get(hash) || hash;
  showConfirm('Supprimer "' + name + '" ?', async () => {
    const df = document.getElementById('modal-delete-files').checked;
    actifsHashes = '';
    await fetchT(BASE + '/api/torrents/' + hash + '?name=' + encodeURIComponent(name) + '&deleteFiles=' + df, { method: 'DELETE', credentials: 'include' });
    loadActifs(); loadStats();
  }, 'Supprimer', { showDeleteFiles: true });
}

/** Suppression manuelle d'un torrent depuis le bouton ✕ du tableau actifs. */
async function deleteManual(hash) {
  const name = torrentDataMap.get(hash) || hash;
  showConfirm('Supprimer ce torrent ?\n\n"' + name + '"', async () => {
    const df = document.getElementById('modal-delete-files').checked;
    actifsHashes = '';
    await fetchT(BASE + '/api/torrents/' + hash + '?name=' + encodeURIComponent(name) + '&deleteFiles=' + df, { method: 'DELETE', credentials: 'include' });
    loadActifs(); loadStats();
  }, 'Supprimer', { showDeleteFiles: true });
}
