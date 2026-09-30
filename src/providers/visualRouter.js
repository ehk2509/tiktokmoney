export class AiFirstVisualProvider {
  constructor({ ai = null, stock = null } = {}) {
    this.ai = ai;
    this.stock = stock;
    this.strategy = ai ? 'ai-first' : stock ? 'stock-only' : 'fallback-card';
  }

  async resolveScene(scene, context = {}) {
    let aiError = null;

    if (this.ai) {
      try {
        const asset = await this.ai.resolveScene(scene, context);
        if (asset) {
          return {
            ...asset,
            routing: {
              selected: 'ai-video',
              fallbackUsed: false,
            },
          };
        }
      } catch (error) {
        aiError = error;
      }
    }

    if (this.stock) {
      return this.resolveFallbackScene(scene, {
        ...context,
        reason: aiError?.message || context.reason || 'ai-video-unavailable',
      });
    }

    if (aiError) throw aiError;
    return null;
  }

  async resolveFallbackScene(scene, context = {}) {
    if (!this.stock) return null;

    const asset = await this.stock.resolveScene(scene, context);
    if (!asset) return null;

    return {
      ...asset,
      routing: {
        selected: 'stock',
        fallbackUsed: true,
        fallbackReason: context.reason || 'ai-video-rejected',
      },
    };
  }
}

export class NullVisualProvider {
  async resolveScene() {
    return null;
  }
}
