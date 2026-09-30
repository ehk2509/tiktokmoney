import http from 'node:http';
import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { ok: true, service: 'tiktokmoney', version: '0.1.0' });
    }

    if (req.method === 'GET' && req.url === '/api/opportunities') {
      return json(res, 200, { items: await app.opportunities() });
    }

    if (req.method === 'POST' && req.url === '/api/videos') {
      const body = await readJson(req);
      const project = await app.pipeline.generate({
        topic: body.topic,
        audience: body.audience,
        durationSeconds: Number(body.durationSeconds || 35),
        render: body.render !== false,
      });
      return json(res, 201, project);
    }

    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`TikTokMoney API listening on http://localhost:${port}`);
});

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
