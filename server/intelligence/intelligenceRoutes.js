"use strict";

const express = require("express");

const {
  executeIntelligenceGateway,
} = require("./intelligenceGateway");
const quoteCompositionReviewService = require("./quoteCompositionReviewService");
const workflowReviewService = require("./workflowReviewService");
const workflowTranscriptionService = require("./workflowTranscriptionService");

const INTELLIGENCE_COMPANION_ROUTE = "/api/companion/ask";
const QUOTE_COMPOSITION_FEEDBACK_ROUTE =
  "/api/intelligence/quote-compositions/:proposalId/feedback";
const WORKFLOW_REVIEW_ROUTE =
  "/api/intelligence/proposals/:proposalId/review";
const WORKFLOW_TRANSCRIPTION_ROUTE = "/api/intelligence/transcriptions";
const INTELLIGENCE_PROVIDER_STATUS_ROUTE = "/api/intelligence/provider-status";

function setIntelligenceNoStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

function createIntelligenceGatewayHandler({
  getPool,
  gateway = executeIntelligenceGateway,
  logger = null,
  ...gatewayDependencies
}) {
  if (typeof getPool !== "function" || typeof gateway !== "function") {
    throw new TypeError("Intelligence route dependencies are required.");
  }

  return async function intelligenceGatewayHandler(req, res) {
    try {
      const result = await gateway({
        ...gatewayDependencies,
        pool: getPool(req),
        authenticatedActor: req.user,
        idempotencyKey: req.headers?.["idempotency-key"],
        body: req.body,
        providers: req.app?.locals?.intelligenceProviders || gatewayDependencies.providers,
        retailerReferenceAdapter:
          req.app?.locals?.retailerReferenceAdapter || gatewayDependencies.retailerReferenceAdapter,
        logger,
      });
      const { ok, status, ...payload } = result;
      return res.status(status).json({ success: ok, ...payload });
    } catch {
      if (logger && typeof logger.error === "function") {
        logger.error("intelligence.gateway.internal_failure", {
          operation: String(req.body?.operation || "unknown").slice(0, 160),
        });
      }
      return res.status(500).json({
        success: false,
        code: "INTELLIGENCE_INTERNAL_FAILURE",
        message: "The Intelligence operation could not be completed.",
      });
    }
  };
}

function registerIntelligenceRoutes({
  app,
  authMiddleware,
  getPool,
  reviewService = quoteCompositionReviewService,
  workflowReview = workflowReviewService,
  transcriptionService = workflowTranscriptionService,
  ...dependencies
}) {
  if (!app || typeof app.post !== "function" || typeof authMiddleware !== "function") {
    throw new TypeError("Intelligence route registration requires an app and authentication.");
  }
  app.post(
    INTELLIGENCE_COMPANION_ROUTE,
    setIntelligenceNoStore,
    authMiddleware,
    createIntelligenceGatewayHandler({ getPool, ...dependencies })
  );
  app.post(
    QUOTE_COMPOSITION_FEEDBACK_ROUTE,
    setIntelligenceNoStore,
    authMiddleware,
    async (req, res) => {
      try {
        const result = await reviewService.recordQuoteCompositionFeedback({
          pool: getPool(req),
          authenticatedActor: req.user,
          proposalId: req.params.proposalId,
          elementId: req.body?.elementId,
          action: req.body?.action,
          editedValue: req.body?.editedValue,
          reasonCategory: req.body?.reasonCategory,
          idempotencyKey: req.headers?.["idempotency-key"],
          logger: dependencies.logger,
        });
        const { ok, status, ...payload } = result;
        return res.status(status).json({ success: ok, ...payload });
      } catch {
        return res.status(500).json({
          success: false,
          code: "QUOTE_COMPOSITION_FEEDBACK_FAILED",
          message: "The Quote Composition feedback could not be recorded.",
        });
      }
    }
  );
  app.post(
    WORKFLOW_REVIEW_ROUTE,
    setIntelligenceNoStore,
    authMiddleware,
    async (req, res) => {
      try {
        const result = await workflowReview.recordWorkflowReview({
          pool: getPool(req),
          authenticatedActor: req.user,
          proposalId: req.params.proposalId,
          elementId: req.body?.elementId,
          action: req.body?.action,
          ...(
            req.body &&
            typeof req.body === "object" &&
            !Array.isArray(req.body) &&
            Object.hasOwn(req.body, "editedValue")
              ? { editedValue: req.body.editedValue }
              : {}
          ),
          reasonCategory: req.body?.reasonCategory,
          idempotencyKey: req.headers?.["idempotency-key"],
          logger: dependencies.logger,
        });
        const { ok, status, ...payload } = result;
        return res.status(status).json({ success: ok, ...payload });
      } catch {
        return res.status(500).json({
          success: false,
          code: "INTELLIGENCE_REVIEW_FAILED",
          message: "The Ask Meetro review could not be recorded.",
        });
      }
    }
  );
  app.post(
    WORKFLOW_TRANSCRIPTION_ROUTE,
    setIntelligenceNoStore,
    authMiddleware,
    express.raw({
      type: ["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-m4a"],
      limit: workflowTranscriptionService.MAX_AUDIO_BYTES,
    }),
    async (req, res) => {
      try {
        const result = await transcriptionService.transcribeWorkflowAudio({
          pool: getPool(req),
          authenticatedActor: req.user,
          idempotencyKey: req.headers?.["idempotency-key"],
          audio: req.body,
          mimeType: req.headers?.["content-type"],
          contextLabel: req.query?.context,
          locale: req.query?.locale,
          provider: req.app?.locals?.intelligenceTranscriptionProvider,
          logger: dependencies.logger,
        });
        const { ok, status, ...payload } = result;
        return res.status(status).json({ success: ok, ...payload });
      } catch {
        return res.status(500).json({
          success: false,
          code: "INTELLIGENCE_TRANSCRIPTION_FAILED",
          message: "The voice recording could not be transcribed.",
        });
      }
    }
  );
  if (typeof app.get === "function") {
    app.get(
      INTELLIGENCE_PROVIDER_STATUS_ROUTE,
      setIntelligenceNoStore,
      authMiddleware,
      (req, res) => {
        const metadata = req.app?.locals?.intelligenceProviderMetadata || {};
        return res.status(200).json({
          success: true,
          configured: metadata.configured === true,
          provider: metadata.provider || null,
          workflowModel: metadata.workflowModel || null,
          transcriptionModel: metadata.transcriptionModel || null,
        });
      }
    );
  }
}

module.exports = {
  INTELLIGENCE_COMPANION_ROUTE,
  INTELLIGENCE_PROVIDER_STATUS_ROUTE,
  QUOTE_COMPOSITION_FEEDBACK_ROUTE,
  WORKFLOW_REVIEW_ROUTE,
  WORKFLOW_TRANSCRIPTION_ROUTE,
  createIntelligenceGatewayHandler,
  registerIntelligenceRoutes,
  setIntelligenceNoStore,
};
