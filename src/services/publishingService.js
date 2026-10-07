import crypto from 'node:crypto';

export class PublishingService {
  constructor({
    projectStore,
    publicationStore,
    publisher,
    learningService = null,
    experimentService = null,
    circuitBreakerService = null,
    now = () => new Date(),
  }) {
    this.projectStore = projectStore;
    this.publicationStore = publicationStore;
    this.publisher = publisher;
    this.learningService = learningService;
    this.experimentService = experimentService;
    this.circuitBreakerService = circuitBreakerService;
    this.now = now;
  }

  async publishProject(projectId, {
    confirmPublish = false,
    title = null,
    privacyLevel = null,
    disableComment = false,
    disableDuet = false,
    disableStitch = false,
    videoCoverTimestampMs = 1000,
    circuitOperation = 'publishing',
  } = {}) {
    if (!confirmPublish) {
      throw new Error('publishing is disabled by default; explicit confirmPublish=true is required');
    }
    if (this.circuitBreakerService?.assertAllowed) {
      await this.circuitBreakerService.assertAllowed(circuitOperation);
    }
    if (!this.publisher?.configured) throw new Error('TikTok publisher is not configured');
    const project = await this.projectStore.getProject(projectId);
    if (!project) throw new Error(`project ${projectId} was not found`);
    if (project.status !== 'RENDERED' || !project.render?.outputPath) {
      throw new Error(`project ${projectId} must be successfully rendered before publishing`);
    }

    const startedAt = this.now().toISOString();
    const result = await this.publisher.publishFile({
      filePath: project.render.outputPath,
      title: title ?? project.productionScript?.title ?? project.script?.title ?? project.topic,
      privacyLevel,
      disableComment,
      disableDuet,
      disableStitch,
      videoCoverTimestampMs,
    });

    const publication = {
      id: `pub_${crypto.randomUUID()}`,
      provider: 'tiktok',
      projectId,
      projectStatusAtPublish: project.status,
      createdAt: startedAt,
      updatedAt: startedAt,
      status: 'PROCESSING_UPLOAD',
      publishId: result.publishId,
      postIds: [],
      privacyLevel: result.privacyLevel,
      title: title ?? project.productionScript?.title ?? project.script?.title ?? project.topic,
      creator: result.creator,
      upload: result.upload,
      metricsSnapshots: [],
      failure: null,
    };
    await this.publicationStore.savePublication(publication);
    return publication;
  }

  async refreshStatus(publicationId) {
    const publication = await this.requirePublication(publicationId);
    const status = await this.publisher.getStatus(publication.publishId);
    publication.status = status.status || publication.status;
    publication.failure = status.fail_reason || null;
    publication.postIds = normalizePostIds(status.publicaly_available_post_id);
    publication.uploadedBytes = Number(status.uploaded_bytes) || publication.uploadedBytes || null;
    publication.updatedAt = this.now().toISOString();
    await this.publicationStore.savePublication(publication);
    return publication;
  }

  async refreshMetrics(publicationId) {
    const publication = await this.refreshStatus(publicationId);
    if (!publication.postIds.length) return publication;

    const videos = await this.publisher.queryVideos(publication.postIds);
    if (videos.length) {
      publication.metricsSnapshots.push({
        capturedAt: this.now().toISOString(),
        videos: videos.map((video) => ({
          id: String(video.id),
          createTime: video.create_time ?? null,
          shareUrl: video.share_url ?? null,
          duration: video.duration ?? null,
          viewCount: numberOrNull(video.view_count),
          likeCount: numberOrNull(video.like_count),
          commentCount: numberOrNull(video.comment_count),
          shareCount: numberOrNull(video.share_count),
          isAigc: video.is_aigc ?? null,
        })),
      });
      publication.updatedAt = this.now().toISOString();
      await this.publicationStore.savePublication(publication);
      if (this.learningService?.recordPublication) {
        publication.latestOutcome = await this.learningService.recordPublication(publication);
        if (publication.latestOutcome?.experiment?.id && this.experimentService?.evaluate) {
          publication.latestExperiment = await this.experimentService.evaluate(
            publication.latestOutcome.experiment.id,
          );
        }
        await this.publicationStore.savePublication(publication);
      }
    }
    return publication;
  }

  async getPublication(id) {
    return this.publicationStore.getPublication(id);
  }

  async listPublications(options = {}) {
    return this.publicationStore.listPublications(options);
  }

  async requirePublication(id) {
    const publication = await this.publicationStore.getPublication(id);
    if (!publication) throw new Error(`publication ${id} was not found`);
    return publication;
  }
}

function normalizePostIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter(Boolean))];
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
