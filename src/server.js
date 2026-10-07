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

    if (req.method === 'POST' && req.url === '/api/tiktok/webhooks') {
      const rawBody = await readRaw(req);
      const received = await app.receiveTikTokWebhook({
        rawBody,
        signatureHeader: req.headers['tiktok-signature'],
      });
      json(res, 200, { ok: true, duplicate: received.duplicate, eventId: received.event.id });
      setImmediate(async () => {
        try {
          await app.processTikTokWebhook(received.event.id);
        } catch (error) {
          console.error(`TikTok webhook processing failed: ${error.message}`);
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/tiktok/webhooks') {
      return json(res, 200, { items: await app.listTikTokWebhooks() });
    }

    if (req.method === 'POST' && req.url === '/api/tiktok/webhooks/process') {
      return json(res, 200, { items: await app.processPendingTikTokWebhooks() });
    }

    if (req.method === 'GET' && req.url === '/api/tiktok/oauth/start') {
      const auth = await app.beginTikTokAuthorization();
      res.writeHead(302, { location: auth.url });
      return res.end();
    }

    if (req.method === 'GET' && req.url?.startsWith('/api/tiktok/oauth/callback')) {
      const url = new URL(req.url, 'http://localhost');
      const token = await app.completeTikTokAuthorization({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
        errorDescription: url.searchParams.get('error_description'),
      });
      const status = await app.tiktokAuthorizationStatus();
      return json(res, 200, {
        ok: true,
        authorized: true,
        scopes: status.scopes,
        openId: status.openId,
        accessTokenExpiresAt: status.accessTokenExpiresAt,
        refreshTokenExpiresAt: status.refreshTokenExpiresAt,
      });
    }

    if (req.method === 'GET' && req.url === '/api/tiktok/oauth/status') {
      return json(res, 200, await app.tiktokAuthorizationStatus());
    }

    if (req.method === 'POST' && req.url === '/api/tiktok/oauth/refresh') {
      await app.refreshTikTokAuthorization();
      return json(res, 200, await app.tiktokAuthorizationStatus());
    }

    if (req.method === 'GET' && req.url === '/api/motion-library') {
      return json(res, 200, { items: await app.listMotionLibrary() });
    }

    if (req.method === 'GET' && req.url === '/api/publications') {
      return json(res, 200, { items: await app.listPublications() });
    }

    const publicationMatch = req.url?.match(/^\/api\/publications\/([^/?]+)$/);
    if (req.method === 'GET' && publicationMatch) {
      const publication = await app.getPublication(decodeURIComponent(publicationMatch[1]));
      return publication
        ? json(res, 200, publication)
        : json(res, 404, { error: 'publication_not_found' });
    }

    const schedulePublicationMatch = req.url?.match(/^\/api\/videos\/([^/?]+)\/schedule$/);
    if (req.method === 'POST' && schedulePublicationMatch) {
      const body = await readJson(req);
      if (body.confirmPublish !== true) {
        return json(res, 400, { error: 'confirmPublish=true is required' });
      }
      if (!body.privacyLevel) return json(res, 400, { error: 'privacyLevel is required' });
      return json(res, 201, await app.schedulePublication(
        decodeURIComponent(schedulePublicationMatch[1]),
        {
          runAt: body.runAt,
          confirmPublish: true,
          privacyLevel: body.privacyLevel,
          title: body.title || null,
          disableComment: Boolean(body.disableComment),
          disableDuet: Boolean(body.disableDuet),
          disableStitch: Boolean(body.disableStitch),
          videoCoverTimestampMs: body.videoCoverTimestampMs,
        },
      ));
    }

    if (req.method === 'GET' && req.url === '/api/orchestration/jobs') {
      return json(res, 200, { items: await app.listOrchestrationJobs() });
    }

    if (req.method === 'POST' && req.url === '/api/orchestration/run') {
      return json(res, 200, { items: await app.runPublicationOrchestration() });
    }

    const publicationRefreshMatch = req.url?.match(/^\/api\/publications\/([^/?]+)\/refresh$/);
    if (req.method === 'POST' && publicationRefreshMatch) {
      return json(
        res,
        200,
        await app.refreshPublication(decodeURIComponent(publicationRefreshMatch[1])),
      );
    }

    const publicationMetricsMatch = req.url?.match(/^\/api\/publications\/([^/?]+)\/metrics$/);
    if (req.method === 'POST' && publicationMetricsMatch) {
      return json(
        res,
        200,
        await app.refreshPublicationMetrics(decodeURIComponent(publicationMetricsMatch[1])),
      );
    }

    if (req.method === 'GET' && req.url === '/api/performance/outcomes') {
      return json(res, 200, { items: await app.listPerformanceOutcomes() });
    }

    if (req.method === 'GET' && req.url?.startsWith('/api/performance/context')) {
      const url = new URL(req.url, 'http://localhost');
      return json(res, 200, await app.performanceLearningContext({
        topic: url.searchParams.get('topic'),
        audience: url.searchParams.get('audience'),
      }));
    }

    if (req.method === 'GET' && req.url === '/api/experiments') {
      return json(res, 200, { items: await app.listExperiments() });
    }

    const experimentMatch = req.url?.match(/^\/api\/experiments\/([^/?]+)\/evaluate$/);
    if (req.method === 'POST' && experimentMatch) {
      return json(res, 200, await app.evaluateExperiment(decodeURIComponent(experimentMatch[1])));
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

    const publishVideoMatch = req.url?.match(/^\/api\/videos\/([^/?]+)\/publish$/);
    if (req.method === 'POST' && publishVideoMatch) {
      const body = await readJson(req);
      if (body.confirmPublish !== true) {
        return json(res, 400, { error: 'confirmPublish=true is required' });
      }
      if (!body.privacyLevel) {
        return json(res, 400, { error: 'privacyLevel is required' });
      }
      const publication = await app.publishProject(decodeURIComponent(publishVideoMatch[1]), {
        confirmPublish: true,
        title: body.title || null,
        privacyLevel: body.privacyLevel,
        disableComment: Boolean(body.disableComment),
        disableDuet: Boolean(body.disableDuet),
        disableStitch: Boolean(body.disableStitch),
        videoCoverTimestampMs: body.videoCoverTimestampMs,
      });
      return json(res, 202, publication);
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
  const raw = await readRaw(req);
  return raw ? JSON.parse(raw) : {};
}

async function readRaw(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}


const orchestrationPollMs = Math.max(
  10000,
  Number(process.env.ORCHESTRATION_POLL_MS || 60000),
);
const orchestrationAutoRun = process.env.ORCHESTRATION_AUTO_RUN == null
  ? true
  : ['1', 'true', 'yes', 'on'].includes(String(process.env.ORCHESTRATION_AUTO_RUN).toLowerCase());

if (orchestrationAutoRun) {
  const timer = setInterval(async () => {
    try {
      await app.runPublicationOrchestration();
      await app.processPendingTikTokWebhooks();
    } catch (error) {
      console.error(`Publication orchestration tick failed: ${error.message}`);
    }
  }, orchestrationPollMs);
  timer.unref();
}
