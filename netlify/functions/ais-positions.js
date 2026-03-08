// netlify/functions/ais-positions.js
// Node.js built-in modüller — npm paketi gerekmez

const tls = require('tls');
const crypto = require('crypto');

const AISSTREAM_KEY = 'a3e7f373beda52f3015c0dd7c1939bc18a050f4a';
const FLEET_MMSI = [
  '538011753','538011525','414317000','538010831',
  '538010800','538011968','538011969','538010634',
  '538011224','271000419'
];

function parseWSFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (buf.length < offset + payloadLen) return null;
  return { opcode, payload: buf.slice(offset, offset + payloadLen), totalLen: offset + payloadLen };
}

function makeWSFrame(data) {
  const payload = Buffer.from(data);
  const frame = Buffer.alloc(2 + payload.length);
  frame[0] = 0x81;
  frame[1] = payload.length;
  payload.copy(frame, 2);
  return frame;
}

exports.handler = async () => {
  const positions = {};

  await new Promise((resolve) => {
    let socket;
    const timer = setTimeout(() => { try { socket && socket.destroy(); } catch(e){} resolve(); }, 18000);

    socket = tls.connect({ host: 'stream.aisstream.io', port: 443, servername: 'stream.aisstream.io' });
    socket.on('error', () => { clearTimeout(timer); resolve(); });

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
        buf = buf.slice(buf.indexOf('\r\n\r\n') + 4);
        socket.write(makeWSFrame(JSON.stringify({
          APIKey: AISSTREAM_KEY,
          BoundingBoxes: [[[-90,-180],[90,180]]],
          FiltersShipMMSI: FLEET_MMSI,
          FilterMessageTypes: ['PositionReport','ShipStaticData'],
        })));
        return;
      }
      while (buf.length > 0) {
        const frame = parseWSFrame(buf);
        if (!frame) break;
        buf = buf.slice(frame.totalLen);
        if (frame.opcode !== 1) continue;
        try {
          const msg = JSON.parse(frame.payload.toString());
          const mmsi = String(msg.MetaData?.MMSI || '');
          if (!mmsi || !FLEET_MMSI.includes(mmsi)) continue;
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
          if (Object.keys(positions).length >= FLEET_MMSI.length) {
            clearTimeout(timer); socket.destroy(); resolve();
          }
        } catch(e) {}
      }
    });
  });

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({ positions, ts: new Date().toISOString() }),
  };
};
