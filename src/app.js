import { TemplateLlmProvider, SampleTrendProvider } from './providers.js';
import { rankOpportunities } from './core/opportunityScorer.js';
import { FfmpegRenderer } from './renderers/ffmpegRenderer.js';
import { JsonStore } from './storage/jsonStore.js';
import { VideoPipeline } from './core/pipeline.js';

export function createApp(overrides = {}) {
  const llm = overrides.llm || new TemplateLlmProvider();
  const trends = overrides.trends || new SampleTrendProvider();
  const renderer = overrides.renderer || new FfmpegRenderer();
  const store = overrides.store || new JsonStore(process.env.DATA_DIR || './data');
  const pipeline = new VideoPipeline({ llm, renderer, store });

  return {
    pipeline,
    async opportunities() {
      return rankOpportunities(await trends.list());
    },
  };
}
