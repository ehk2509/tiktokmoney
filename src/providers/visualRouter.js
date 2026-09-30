export class AiFirstVisualProvider {
  constructor({ ai = null, stock = null } = {}) {
    this.ai = ai;
    this.stock = stock;
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
      try {
        const asset = await this.stock.resolveScene(scene, context);
        if (asset) {
          return {
            ...asset,
            routing: {
              selected: 'stock',
              fallbackUsed: Boolean(aiError),
              fallbackReason: aiError?.message || null,
            },
          };
        }
      } catch (stockError) {
        if (aiError) {
          throw new Error(`AI video failed: ${aiError.message}; stock fallback failed: ${stockError.message}`);
        }
        throw stockError;
      }
    }

    if (aiError) throw aiError;
    return null;
  }
}

export class NullVisualProvider {
  async resolveScene() {
    return null;
  }
}
