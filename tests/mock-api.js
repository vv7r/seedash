'use strict';
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- qBittorrent mock (port 8080) ---
const qbitApp = express();
qbitApp.use(express.urlencoded({ extended: true }));
let qbitAuthed = false;
const INITIAL_TORRENTS = [
  { hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', name: 'Movie 2024 1080p BluRay x264', state: 'uploading', ratio: 2.5, size: 4500000000, added_on: Math.floor(Date.now()/1000) - 86400*10, seeding_time: 86400*10, num_leechs: 3, num_seeds: 5, dlspeed: 0, upspeed: 1500000, completion_on: 0 },
  { hash: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b1c2', name: 'Show S01E01 1080p WEB x264', state: 'downloading', ratio: 0, size: 800000000, added_on: Math.floor(Date.now()/1000) - 3600*5, seeding_time: 0, num_leechs: 8, num_seeds: 2, dlspeed: 2000000, upspeed: 0, completion_on: 0 },
  { hash: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b2c3d4', name: 'Album 2024 Flac', state: 'uploading', ratio: 1.8, size: 350000000, added_on: Math.floor(Date.now()/1000) - 86400*3, seeding_time: 86400*3, num_leechs: 1, num_seeds: 12, dlspeed: 0, upspeed: 500000, completion_on: 0 },
];
let mockTorrents = [...INITIAL_TORRENTS];

qbitApp.post('/api/v2/auth/login', (req, res) => {
  qbitAuthed = true;
  res.cookie('SID', 'mock-session-id');
  res.json('Ok.');
});
qbitApp.get('/api/v2/torrents/info', (req, res) => {
  if (!qbitAuthed) return res.status(403).json({ status: false, message: 'Not authenticated' });
  res.json(mockTorrents);
});
qbitApp.get('/api/v2/transfer/info', (req, res) => {
  if (!qbitAuthed) return res.status(403).json({ status: false, message: 'Not authenticated' });
  res.json({ dl_info_speed: 2500000, up_info_speed: 1800000, all_loads: 3 });
});
qbitApp.post('/api/v2/torrents/add', (req, res) => {
  if (!qbitAuthed) return res.status(403).json({ status: false, message: 'Not authenticated' });
  const urls = req.body.urls || req.query.urls || '';
  const hash = require('crypto').createHash('sha1').update(urls).digest('hex');
  if (!mockTorrents.find(t => t.hash === hash)) {
    mockTorrents.push({ hash, name: 'New Torrent', state: 'downloading', ratio: 0, size: 1000000000, added_on: Math.floor(Date.now()/1000), seeding_time: 0, num_leechs: 1, num_seeds: 1, dlspeed: 500000, upspeed: 0, completion_on: 0 });
  }
  res.json('Ok.');
});
qbitApp.post('/api/v2/torrents/delete', (req, res) => {
  if (!qbitAuthed) return res.status(403).json({ status: false, message: 'Not authenticated' });
  const hashes = ((req.body.hashes || req.query.hashes) || '').split('|').filter(Boolean);
  for (const h of hashes) {
    const idx = mockTorrents.findIndex(t => t.hash === h);
    if (idx !== -1) mockTorrents.splice(idx, 1);
  }
  res.json('Ok.');
});
qbitApp.get('/api/v2/sync/maindata', (req, res) => {
  if (!qbitAuthed) return res.status(403).json({ status: false, message: 'Not authenticated' });
  res.json({ main_data: {} });
});
qbitApp.post('/api/v2/torrents/reset', (req, res) => {
  const now = Math.floor(Date.now()/1000);
  mockTorrents = [
    { ...INITIAL_TORRENTS[0], added_on: now - 86400*10 },
    { ...INITIAL_TORRENTS[1], added_on: now - 3600*5 },
    { ...INITIAL_TORRENTS[2], added_on: now - 86400*3 },
  ];
  res.json('Ok.');
});

// --- C411 mock (port 8081) ---
const c411App = express();
const mockTorrentsC411 = [
  { id: 1001, title: 'Movie 2024 1080p BluRay x264', size: 4500000000, seeders: 12, peers: 15, infohash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', category: 2000, link: 'http://127.0.0.1:8081/torrents/1001', url: 'http://127.0.0.1:8081/api?t=get&id=1001&apikey=mock', pubDate: new Date().toISOString() },
  { id: 1002, title: 'Show S02E05 2160p WEB x265', size: 3200000000, seeders: 8, peers: 22, infohash: 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b3c4d5', category: 5000, link: 'http://127.0.0.1:8081/torrents/1002', url: 'http://127.0.0.1:8081/api?t=get&id=1002&apikey=mock', pubDate: new Date().toISOString() },
  { id: 1003, title: 'Album 2024 Flac 24bit', size: 550000000, seeders: 25, peers: 30, infohash: 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b4c5d6e7', category: 3000, link: 'http://127.0.0.1:8081/torrents/1003', url: 'http://127.0.0.1:8081/api?t=get&id=1003&apikey=mock', pubDate: new Date().toISOString() },
  { id: 1004, title: 'Game 2024 x64', size: 15000000000, seeders: 5, peers: 40, infohash: 'f6a7b8c9d0e1f2a3b4c5d6e7f8a9b5c6d7e8f9', category: 4000, link: 'http://127.0.0.1:8081/torrents/1004', url: 'http://127.0.0.1:8081/api?t=get&id=1004&apikey=mock', pubDate: new Date().toISOString() },
  { id: 1005, title: 'Doc 2024 1080p WEB x264', size: 2100000000, seeders: 18, peers: 25, infohash: 'a7b8c9d0e1f2a3b4c5d6e7f8a9b6c7d8e9f0a1', category: 2000, link: 'http://127.0.0.1:8081/torrents/1005', url: 'http://127.0.0.1:8081/api?t=get&id=1005&apikey=mock', pubDate: new Date().toISOString() },
];

function c411Xml(torrents) {
  const items = torrents.map(t => `
    <item>
      <title>${t.title}</title>
      <link>${t.link}</link>
      <guid isPermaLink="false">${t.infohash}</guid>
      <pubDate>${t.pubDate}</pubDate>
      <torznab:attr name="infohash" value="${t.infohash}"/>
      <torznab:attr name="size" value="${t.size}"/>
      <torznab:attr name="seeders" value="${t.seeders}"/>
      <torznab:attr name="peers" value="${t.peers}"/>
      <torznab:attr name="category" value="${t.category}"/>
      <torznab:attr name="downloadvolumefactor" value="1"/>
      <enclosure url="${t.url}" length="${t.size}" type="application/x-bittorrent"/>
    </item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/site">
  <channel>
    <title>Mock C411</title>
    <link>https://c411.org</link>
    <description>Mock tracker</description>
    ${items}
  </channel>
</rss>`;
}

c411App.get('/api/torznab', (req, res) => {
  const t = req.query.t;
  if (t === 'caps') {
    res.type('application/xml').send(`<?xml version="1.0"?><caps><categories><category id="2000" name="Films"/><category id="3000" name="Musique"/><category id="4000" name="Jeux"/><category id="5000" name="TV"/></categories></caps>`);
    return;
  }
  if (t === 'search') {
    const q = (req.query.q || '').toLowerCase();
    let items = mockTorrentsC411;
    if (q) items = items.filter(x => x.title.toLowerCase().includes(q) || x.infohash === q);
    res.type('application/xml').send(c411Xml(items));
    return;
  }
  if (t === 'get') {
    const id = req.query.id;
    const tor = mockTorrentsC411.find(x => String(x.id) === String(id));
    if (!tor) return res.status(404).send('Not found');
    res.type('application/x-bittorrent').send(`d8:announc5:mock12:created byyyyyy2eend`);
    return;
  }
  res.status(400).send('Unknown t parameter');
});

c411App.get('/api', (req, res) => {
  const t = req.query.t;
  if (t === 'get') {
    const id = req.query.id;
    const tor = mockTorrentsC411.find(x => String(x.id) === String(id));
    if (!tor) return res.status(404).send('Not found');
    res.type('application/x-bittorrent').send(`d8:announc5:mock12:created byyyyyy2eend`);
    return;
  }
  res.status(400).send('Unknown t parameter');
});

// --- Ultra.cc mock (port 8082) ---
const ultraccApp = express();
ultraccApp.get('/ultra-api/total-stats', (req, res) => {
  res.json({
    service_stats_info: {
      disk_used_bytes: 500 * 1024 * 1024 * 1024,
      disk_quota_bytes: 1000 * 1024 * 1024 * 1024,
      monthly_upload_bytes: 150 * 1024 * 1024 * 1024,
      monthly_download_bytes: 30 * 1024 * 1024 * 1024,
      monthly_quota_bytes: 500 * 1024 * 1024 * 1024,
      hostname: 'mock-seedbox',
    },
  });
});

// --- Start all three ---
qbitApp.listen(8080, () => console.log('[mock] qBittorrent → http://127.0.0.1:8080'));
c411App.listen(8081, () => console.log('[mock] C411 → http://127.0.0.1:8081'));
ultraccApp.listen(8082, () => console.log('[mock] Ultra.cc → http://127.0.0.1:8082'));
