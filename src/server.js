import http from 'node:http';
import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'tiktokmoney',
        version: process.env.npm_package_version || '0.24.0',
        mode: app.mode,
        capabilities: app.capabilities,
      });
    }

    if (req.method === 'GET' && req.url === '/api/motion-library') {
      return json(res, 200, { items: await app.listMotionLibrary() });
    }

    if (req.method === 'GET' && req.url === '/api/opportunities') {
      return json(res, 200, { items: await app.opportunities() });
    }

    if (req.method === 'GET' && req.url?.startsWith('/api/research')) {
      const url = new URL(req.url, 'http://localhost');
      const topic = url.searchParams.get('topic');
      if (!topic) return json(res, 400, { error: 'topic is required' });
      const packet = await app.research(topic);
      if (!packet) return json(res, 503, { error: 'trend_intelligence_not_configured' });
      return json(res, 200, packet);
    }

    if (req.method === 'GET' && req.url === '/api/plans') {
      return json(res, 200, { items: await app.listPlans() });
    }

    if (req.method === 'POST' && req.url === '/api/plans') {
      const body = await readJson(req);
      const plan = await app.planDay({
        date: body.date,
        budgetUsd: body.budgetUsd,
        maxVideos: body.maxVideos,
        audience: body.audience,
        durationSeconds: body.durationSeconds,
        render: body.render !== false,
      });
      return json(res, 201, plan);
    }

    const planMatch = req.url?.match(/^\/api\/plans\/([^/?]+)$/);
    if (req.method === 'GET' && planMatch) {
      const plan = await app.getPlan(decodeURIComponent(planMatch[1]));
      return plan ? json(res, 200, plan) : json(res, 404, { error: 'plan_not_found' });
    }

    const runPlanMatch = req.url?.match(/^\/api\/plans\/([^/?]+)\/run$/);
    if (req.method === 'POST' && runPlanMatch) {
      const body = await readJson(req);
      const plan = await app.runPlan(decodeURIComponent(runPlanMatch[1]), {
        render: body.render == null ? null : Boolean(body.render),
        stopOnFailure: Boolean(body.stopOnFailure),
      });
      return json(res, 200, plan);
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
