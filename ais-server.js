const WebSocket = require('ws');
const http = require('http');

const AISSTREAM_KEY = 'a3e7f373beda52f3015c0dd7c1939bc18a050f4a';
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
    console.log('[AIS] ✅ Bağlandı, subscribe gönderiliyor...');
    ws.send(JSON.stringify({
      APIKey: AISSTREAM_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FiltersShipMMSI: FLEET_MMSI,
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    }));
    console.log('[AIS] Subscribe gönderildi');
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
      console.log('[AIS] 📡', mmsi, positions[mmsi].lat?.toFixed(2), positions[mmsi].lon?.toFixed(2));
    } catch(e) {}
  });

  ws.on('error', (err) => {
    wsConnected = false;
    console.error('[AIS] Hata:', err.message);
    reconnectTimer = setTimeout(connectAIS, 10000);
  });

  ws.on('close', (code, reason) => {
    wsConnected = false;
    console.log('[AIS] Kapandı:', code, reason?.toString());
    reconnectTimer = setTimeout(connectAIS, 8000);
  });
}

connectAIS();

setInterval(() => {
  console.log('[STATUS] connected:', wsConnected, '| vessels:', Object.keys(positions).length);
}, 60000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/positions' || req.url === '/') {
    res.end(JSON.stringify({ connected: wsConnected, positions, ts: new Date().toISOString() }));
  } else if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true, connected: wsConnected, vessels: Object.keys(positions).length }));
  } else {
    res.statusCode = 404; res.end('{}');
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('[SERVER] Port', PORT, 'hazır'));
