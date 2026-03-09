const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const AISSTREAM_KEY = 'a3e7f373beda52f3015c0dd7c1939bc18a050f4a';
const OIL_API_KEY = 'e77f25ebeb681615184bc0d676ae944901e66aa01035ea23f001459216526760';

const FLEET_MMSI = [
  '538011753','538011525','414317000','538010831',
  '538010800','538011968','538011969','538010634',
  '538011224','271000419'
];

let positions = {};
let wsConnected = false;
let reconnectTimer = null;

function connectAIS() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  console.log('[AIS] Bağlanıyor...');
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream', {
    handshakeTimeout: 10000,
    rejectUnauthorized: false,
  });
  ws.on('open', () => {
    wsConnected = true;
    console.log('[AIS] Baglandı');
    ws.send(JSON.stringify({
      APIKey: AISSTREAM_KEY,
      BoundingBoxes: [[[-90,-180],[90,180]]],
      FiltersShipMMSI: FLEET_MMSI,
      FilterMessageTypes: ['PositionReport','ShipStaticData'],
    }));
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const mmsi = String(msg.MetaData?.MMSI || '');
      if (!mmsi || !FLEET_MMSI.includes(mmsi)) return;
      if (!positions[mmsi]) positions[mmsi] = { mmsi };
      const meta = msg.MetaData || {};
      const pr = msg.Message?.PositionReport;
      const sd = msg.Message?.ShipStaticData;
      if (meta.latitude != null) positions[mmsi].lat = meta.latitude;
      if (meta.longitude != null) positions[mmsi].lon = meta.longitude;
      if (meta.ShipName) positions[mmsi].name = meta.ShipName.trim();
      if (pr?.Sog != null) positions[mmsi].sog = pr.Sog;
      if (pr?.Cog != null) positions[mmsi].cog = pr.Cog;
      if (pr?.TrueHeading != null) positions[mmsi].heading = pr.TrueHeading;
      if (pr?.NavigationalStatus != null) positions[mmsi].navStatus = pr.NavigationalStatus;
      if (sd?.Destination) positions[mmsi].destination = sd.Destination.trim();
      positions[mmsi].ts = new Date().toISOString();
      console.log('[AIS]', mmsi, positions[mmsi].lat?.toFixed(2), positions[mmsi].lon?.toFixed(2));
    } catch(e) {}
  });
  ws.on('error', (err) => {
    wsConnected = false;
    console.error('[AIS] Hata:', err.message);
    reconnectTimer = setTimeout(connectAIS, 15000);
  });
  ws.on('close', (code) => {
    wsConnected = false;
    console.log('[AIS] Kapandı:', code);
    reconnectTimer = setTimeout(connectAIS, 15000);
  });
}

connectAIS();
setInterval(() => {
  console.log('[STATUS] AIS:', wsConnected, '| vessels:', Object.keys(positions).length);
}, 60000);

function fetchOilAPI(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.oilpriceapi.com',
      path,
      method: 'GET',
      headers: { 'Authorization': 'Token ' + OIL_API_KEY, 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const url = req.url.split('?')[0];
  const qs = req.url.includes('?') ? req.url.split('?')[1] : '';

  if (url === '/positions' || url === '/') {
    return res.end(JSON.stringify({ connected: wsConnected, positions, ts: new Date().toISOString() }));
  }
  if (url === '/health') {
    return res.end(JSON.stringify({ ok: true, connected: wsConnected, vessels: Object.keys(positions).length }));
  }
  if (url === '/oil/price') {
    const code = new URLSearchParams(qs).get('by_code') || 'BRENT_CRUDE_USD';
    try {
      const r = await fetchOilAPI('/v1/prices/latest?by_code=' + code);
      res.statusCode = r.status;
      return res.end(JSON.stringify(r.data));
    } catch(e) { res.statusCode = 502; return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/oil/bunker') {
    const port = new URLSearchParams(qs).get('port') || '';
    const apiPath = port ? '/v1/marine-ports/' + port : '/v1/marine-ports';
    try {
      const r = await fetchOilAPI(apiPath);
      res.statusCode = r.status;
      return res.end(JSON.stringify(r.data));
    } catch(e) { res.statusCode = 502; return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/oil/ports') {
    try {
      const r = await fetchOilAPI('/v1/marine-ports');
      res.statusCode = r.status;
      return res.end(JSON.stringify(r.data));
    } catch(e) { res.statusCode = 502; return res.end(JSON.stringify({ error: e.message })); }
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('[SERVER] Port', PORT, 'hazir'));
