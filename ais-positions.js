const WebSocket = require('ws');

const AISSTREAM_KEY = 'a3e7f373beda52f3015c0dd7c1939bc18a050f4a';

const FLEET_MMSI = [
  '538011753','538011525','414317000','538010831',
  '538010800','538011968','538011969','538010634',
  '538011224','271000419'
];

exports.handler = async () => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const positions = {};
  
  await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 20000); // 20sn max bekle
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    
    ws.on('open', () => {
      ws.send(JSON.stringify({
        APIKey: AISSTREAM_KEY,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FiltersShipMMSI: FLEET_MMSI,
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const mmsi = String(msg.MetaData?.MMSI || '');
        if (!mmsi || !FLEET_MMSI.includes(mmsi)) return;

        if (!positions[mmsi]) positions[mmsi] = { mmsi };

        const meta = msg.MetaData || {};
        const pos = msg.Message?.PositionReport;
        const stat = msg.Message?.ShipStaticData;

        if (meta.latitude != null) positions[mmsi].lat = meta.latitude;
        if (meta.longitude != null) positions[mmsi].lon = meta.longitude;
        if (meta.ShipName) positions[mmsi].name = meta.ShipName.trim();
        if (pos?.Sog != null) positions[mmsi].sog = pos.Sog;
        if (pos?.Cog != null) positions[mmsi].cog = pos.Cog;
        if (pos?.TrueHeading != null) positions[mmsi].heading = pos.TrueHeading;
        if (pos?.NavigationalStatus != null) positions[mmsi].navStatus = pos.NavigationalStatus;
        if (stat?.Destination) positions[mmsi].destination = stat.Destination.trim();
        positions[mmsi].ts = new Date().toISOString();

        // Tüm gemileri aldıysak erken bitir
        if (Object.keys(positions).length >= FLEET_MMSI.length) {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch(e) {}
    });

    ws.on('error', () => { clearTimeout(timeout); resolve(); });
    ws.on('close', () => { clearTimeout(timeout); resolve(); });
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ positions, ts: new Date().toISOString() }),
  };
};
