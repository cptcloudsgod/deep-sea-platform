const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const http = require('http');

const AISSTREAM_KEY = 'a3e7f373beda52f3015c0dd7c1939bc18a050f4a';
const FLEET_MMSI = [
  '538011753','538011525','414317000','538010831',
  '538010800','538011968','538011969','538010634',
  '538011224','271000419'
];

// Son bilinen pozisyonları bellekte tut
let positions = {};
let wsConnected = false;

function makeWSFrame(data) {
  const payload = Buffer.from(data);
  const frame = Buffer.alloc(2 + payload.length);
  frame[0] = 0x81;
  frame[1] = payload.length;
  payload.copy(frame, 2);
  return frame;
}

function parseWSFrames(buf) {
  const frames = [];
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;
    if (payloadLen === 126) { if (buf.length < 4) break; payloadLen = buf.readUInt16BE(2); offset = 4; }
    else if (payloadLen === 127) { if (buf.length < 10) break; payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
    if (buf.length < offset + payloadLen) break;
    frames.push({ opcode, payload: buf.slice(offset, offset + payloadLen) });
    buf = buf.slice(offset + payloadLen);
  }
  return { frames, remaining: buf };
}

function connectAIS() {
  console.log('[AIS] Bağlanıyor...');
  wsConnected = false;

  const socket = tls.connect({
    host: 'stream.aisstream.io',
    port: 443,
    servername: 'stream.aisstream.io',
  });

  socket.on('error', (err) => {
    console.error('[AIS] Hata:', err.message);
    setTimeout(connectAIS, 10000);
  });

  socket.on('connect', () => {
    const key = crypto.randomBytes(16).toString('base64');
    socket.write(
      'GET /v0/stream HTTP/1.1\r\n' +
      'Host: stream.aisstream.io\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + key + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n'
    );
  });

  let upgraded = false;
  let buf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    if (!upgraded) {
      const str = buf.toString();
      if (!str.includes('101')) return;
      upgraded = true;
      wsConnected = true;
      console.log('[AIS] ✅ Bağlandı');
      buf = buf.slice(buf.indexOf('\r\n\r\n') + 4);

      socket.write(makeWSFrame(JSON.stringify({
        APIKey: AISSTREAM_KEY,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FiltersShipMMSI: FLEET_MMSI,
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      })));
      return;
    }

    const result = parseWSFrames(buf);
    buf = result.remaining;

    result.frames.forEach(frame => {
      if (frame.opcode === 8) { // close
        console.log('[AIS] Sunucu bağlantıyı kapattı');
        socket.destroy();
        setTimeout(connectAIS, 5000);
        return;
      }
      if (frame.opcode !== 1) return;
      try {
        const msg = JSON.parse(frame.payload.toString());
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
        console.log('[AIS] 📡', mmsi, positions[mmsi].lat, positions[mmsi].lon);
      } catch(e) {}
    });
  });

  socket.on('close', () => {
    wsConnected = false;
    console.log('[AIS] Bağlantı kesildi, yeniden bağlanıyor...');
    setTimeout(connectAIS, 5000);
  });
}

// AIS bağlantısını başlat
connectAIS();

// HTTP server - pozisyon verilerini sun
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/positions') {
    res.end(JSON.stringify({ connected: wsConnected, positions, ts: new Date().toISOString() }));
  } else if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true, connected: wsConnected, vessels: Object.keys(positions).length }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] http://localhost:${PORT} dinleniyor`));
