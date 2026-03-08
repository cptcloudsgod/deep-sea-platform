const tls = require('tls');
const crypto = require('crypto');
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

function makeWSFrame(data) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, payload]);
}

function parseWSFrames(buf) {
  const frames = [];
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;
    if (payloadLen === 126) {
      if (buf.length < 4) break;
      payloadLen = buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buf.length < 10) break;
      payloadLen = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    if (buf.length < offset + payloadLen) break;
    frames.push({ opcode, payload: buf.slice(offset, offset + payloadLen) });
    buf = buf.slice(offset + payloadLen);
  }
  return { frames, remaining: buf };
}

function connectAIS() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  wsConnected = false;
  console.log('[AIS] Bağlanıyor...');

  let socket;
  try {
    socket = tls.connect({
      host: 'stream.aisstream.io',
      port: 443,
      servername: 'stream.aisstream.io',
      rejectUnauthorized: false,
    });
  } catch(e) {
    console.error('[AIS] TLS oluşturma hatası:', e.message);
    reconnectTimer = setTimeout(connectAIS, 10000);
    return;
  }

  const connectTimeout = setTimeout(() => {
    console.log('[AIS] Bağlantı timeout');
    socket.destroy();
  }, 15000);

  socket.on('error', (err) => {
    clearTimeout(connectTimeout);
    console.error('[AIS] Hata:', err.message);
    reconnectTimer = setTimeout(connectAIS, 10000);
  });

  socket.on('connect', () => {
    console.log('[AIS] TLS bağlandı, HTTP upgrade gönderiliyor...');
    const key = crypto.randomBytes(16).toString('base64');
    const handshake =
      'GET /v0/stream HTTP/1.1\r\n' +
      'Host: stream.aisstream.io\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + key + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      'Origin: https://ais-proxy-x31h.onrender.com\r\n' +
      '\r\n';
    socket.write(handshake);
  });

  let upgraded = false;
  let buf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    if (!upgraded) {
      const str = buf.toString('utf8', 0, Math.min(buf.length, 500));
      if (str.includes('HTTP/1.1 101') || str.includes('HTTP/1.0 101')) {
        clearTimeout(connectTimeout);
        upgraded = true;
        wsConnected = true;
        const headerEnd = buf.indexOf('\r\n\r\n');
        buf = headerEnd >= 0 ? buf.slice(headerEnd + 4) : Buffer.alloc(0);
        console.log('[AIS] ✅ WebSocket açık, subscribe gönderiliyor...');

        const subMsg = JSON.stringify({
          APIKey: AISSTREAM_KEY,
          BoundingBoxes: [[[-90, -180], [90, 180]]],
          FiltersShipMMSI: FLEET_MMSI,
          FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
        });
        socket.write(makeWSFrame(subMsg));
        console.log('[AIS] Subscribe gönderildi, mesaj bekleniyor...');
      } else if (str.includes('HTTP/1.1 4') || str.includes('HTTP/1.1 5')) {
        clearTimeout(connectTimeout);
        console.error('[AIS] HTTP hata:', str.split('\r\n')[0]);
        socket.destroy();
      }
      return;
    }

    const result = parseWSFrames(buf);
    buf = result.remaining;

    result.frames.forEach(frame => {
      if (frame.opcode === 8) {
        console.log('[AIS] Sunucu close frame gönderdi');
        socket.destroy();
        return;
      }
      if (frame.opcode === 9) { // ping
        socket.write(makeWSFrame('')); // pong
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
        console.log('[AIS] 📡', mmsi, positions[mmsi].lat?.toFixed(2), positions[mmsi].lon?.toFixed(2));
      } catch(e) {}
    });
  });

  socket.on('close', () => {
    clearTimeout(connectTimeout);
    wsConnected = false;
    console.log('[AIS] Bağlantı kapandı, 8 saniye sonra yeniden bağlanıyor...');
    reconnectTimer = setTimeout(connectAIS, 8000);
  });
}

connectAIS();

// Keep-alive: 45 saniyede bir ping benzeri istek
setInterval(() => {
  console.log('[KEEPALIVE] vessels:', Object.keys(positions).length, '| connected:', wsConnected);
}, 45000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/positions' || req.url === '/') {
    res.end(JSON.stringify({ connected: wsConnected, positions, ts: new Date().toISOString() }));
  } else if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true, connected: wsConnected, vessels: Object.keys(positions).length }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('[SERVER] Port', PORT, 'dinleniyor'));
