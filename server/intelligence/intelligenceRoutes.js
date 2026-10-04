"use strict";

const express = require("express");

const {
  executeIntelligenceGateway,
} = require("./intelligenceGateway");
const quoteCompositionReviewService = require("./quoteCompositionReviewService");
const workflowReviewService = require("./workflowReviewService");
const workflowTranscriptionService = require("./workflowTranscriptionService");
const {
  isPlainObject,
} = require("./intelligenceGatewayContracts");
const {
  canonicalQuickQuoteAnalysisSessionService,
} = require("./quickQuoteAnalysisSessionService");
const {
  canonicalQuickQuoteAnalysisReviewedResultService,
} = require("./quickQuoteAnalysisReviewedResultService");
const {
  canonicalQuickQuoteAnalysisContinuationService,
} = require("./quickQuoteAnalysisContinuationService");

const INTELLIGENCE_COMPANION_ROUTE = "/api/companion/ask";
const QUOTE_COMPOSITION_FEEDBACK_ROUTE =
  "/api/intelligence/quote-compositions/:proposalId/feedback";
const WORKFLOW_REVIEW_ROUTE =
  "/api/intelligence/proposals/:proposalId/review";
const WORKFLOW_TRANSCRIPTION_ROUTE = "/api/intelligence/transcriptions";
const INTELLIGENCE_PROVIDER_STATUS_ROUTE = "/api/intelligence/provider-status";

const QUICK_QUOTE_ANALYSIS_SESSION_COLLECTION_ROUTE =
  "/api/intelligence/quick-quote-analysis/sessions";

const QUICK_QUOTE_ANALYSIS_SESSION_ROUTE =
  "/api/intelligence/quick-quote-analysis/sessions/:sessionId";

const QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_ROUTE =
  "/api/intelligence/quick-quote-analysis/sessions/:sessionId/reviewed-result";

const QUICK_QUOTE_ANALYSIS_EVIDENCE_ROUTE =
  "/api/intelligence/quick-quote-analysis/sessions/:sessionId/evidence";

const QUICK_QUOTE_ANALYSIS_ANALYZE_ROUTE =
  "/api/intelligence/quick-quote-analysis/sessions/:sessionId/analyze";

const QUICK_QUOTE_ANALYSIS_CONTINUE_ROUTE =
  "/api/intelligence/quick-quote-analysis/sessions/:sessionId/continue";

function setIntelligenceNoStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

function normalizeQuickQuoteAnalysisEvidenceBody(body) {
  if (!isPlainObject(body)) return null;

  const allowed = new Set([
    "professionalInput",
    "photos",
  ]);

  const normalized = {};

  for (const key of Reflect.ownKeys(body)) {
    if (
      typeof key !== "string" ||
      !allowed.has(key)
    ) {
      return null;
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(
        body,
        key
      );

    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(
        descriptor,
        "value"
      )
    ) {
      return null;
    }

    normalized[key] =
      descriptor.value;
  }

  return normalized;
}

function normalizeQuickQuoteAnalysisExecutionBody(
  body,
  {
    continuation = false,
  } = {}
) {
  const source =
    body == null
      ? {}
      : body;

  if (!isPlainObject(source)) {
    return null;
  }

  const allowed =
    new Set(
      continuation
        ? [
            "priorProposalId",
            "message",
            "locale",
          ]
        : [
            "locale",
          ]
    );

  const required =
    continuation
      ? new Set([
          "priorProposalId",
          "message",
        ])
      : new Set();

  const normalized = {};

  for (const key of Reflect.ownKeys(source)) {
    if (
      typeof key !== "string" ||
      !allowed.has(key)
    ) {
      return null;
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(
        source,
        key
      );

    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(
        descriptor,
        "value"
      )
    ) {
      return null;
    }

    normalized[key] =
      descriptor.value;
  }

  for (const key of required) {
    if (
      !Object.hasOwn(
        normalized,
        key
      )
    ) {
      return null;
    }
  }

  return normalized;
}

function quickQuoteAnalysisDiscardBodyIsEmpty(body) {
  if (body == null) return true;

  return (
    isPlainObject(body) &&
    Reflect.ownKeys(body).length === 0
  );
}

function sendQuickQuoteAnalysisResult(
  res,
  result
) {
  const {
    ok,
    status,
    ...payload
  } = result;

  return res
    .status(status)
    .json({
      success: ok,
      ...payload,
    });
}

function sendQuickQuoteAnalysisRouteFailure(res) {
  return res.status(500).json({
    success: false,
    code:
      "QUICK_QUOTE_ANALYSIS_REQUEST_FAILED",
    message:
      "The private Job Analysis request could not be completed.",
  });
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
      const pool = getPool(req);
      const authenticatedActor = await resolveIntelligenceAuthenticatedActor({
        pool,
        authenticatedActor: req.user,
      });
      const result = await gateway({
        ...gatewayDependencies,
        pool,
        authenticatedActor,
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

async function resolveIntelligenceAuthenticatedActor({
  pool,
  authenticatedActor,
} = {}) {
  const role = String(authenticatedActor?.role || "").trim().toLowerCase();
  const accountType = String(authenticatedActor?.accountType || "").trim().toLowerCase();
  if (
    ["homeowner", "professional"].includes(role) ||
    ["homeowner", "professional"].includes(accountType)
  ) {
    return authenticatedActor;
  }

  const actorId = Number(authenticatedActor?.id);
  if (!Number.isInteger(actorId) || actorId <= 0 || !pool?.query) {
    return authenticatedActor;
  }

  const result = await pool.query(
    `
    /* intelligence_gateway:actor_account_type */
    SELECT account_type
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [actorId]
  );

  return {
    ...authenticatedActor,
    accountType: result.rows[0]?.account_type,
  };
}

function registerIntelligenceRoutes({
  app,
  authMiddleware,
  getPool,
  reviewService = quoteCompositionReviewService,
  workflowReview = workflowReviewService,
  transcriptionService = workflowTranscriptionService,
  analysisSessionService =
    canonicalQuickQuoteAnalysisSessionService,
  analysisReviewedResultService =
    canonicalQuickQuoteAnalysisReviewedResultService,
  analysisContinuationService =
    canonicalQuickQuoteAnalysisContinuationService,
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
    QUICK_QUOTE_ANALYSIS_SESSION_COLLECTION_ROUTE,
    setIntelligenceNoStore,
    authMiddleware,
    async (req, res) => {
      const evidence =
        normalizeQuickQuoteAnalysisEvidenceBody(
          req.body
        );

      if (!evidence) {
        return res.status(400).json({
          success: false,
          code:
            "QUICK_QUOTE_ANALYSIS_REQUEST_INVALID",
          message:
            "The Job Analysis request is invalid.",
        });
      }

      try {
        const result =
          await analysisSessionService
            .createSession({
              pool: getPool(req),
              authenticatedActor:
                req.user,
              idempotencyKey:
                req.headers?.[
                  "idempotency-key"
                ],
              ...evidence,
            });

        return sendQuickQuoteAnalysisResult(
          res,
          result
        );
      } catch {
        return sendQuickQuoteAnalysisRouteFailure(
          res
        );
      }
    }
  );

  app.post(
    QUICK_QUOTE_ANALYSIS_EVIDENCE_ROUTE,
    setIntelligenceNoStore,
    authMiddleware,
    async (req, res) => {
      const evidence =
        normalizeQuickQuoteAnalysisEvidenceBody(
          req.body
        );

      if (!evidence) {
        return res.status(400).json({
          success: false,
          code:
            "QUICK_QUOTE_ANALYSIS_REQUEST_INVALID",
          message:
            "The Job Analysis request is invalid.",
        });
      }

      try {
        const result =
          await analysisSessionService
            .appendEvidence({
              pool: getPool(req),
              authenticatedActor:
                req.user,
              sessionId:
                req.params.sessionId,
              idempotencyKey:
                req.headers?.[
                  "idempotency-key"
                ],
              ...evidence,
            });

        return sendQuickQuoteAnalysisResult(
          res,
          result
        );
      } catch {
        return sendQuickQuoteAnalysisRouteFailure(
          res
        );
      }
    }
  );

  if (typeof app.get === "function") {
    app.get(
      QUICK_QUOTE_ANALYSIS_SESSION_ROUTE,
      setIntelligenceNoStore,
      authMiddleware,
      async (req, res) => {
        try {
          const result =
            await analysisSessionService
              .getSession({
                pool: getPool(req),
                authenticatedActor:
                  req.user,
                sessionId:
                  req.params.sessionId,
              });

          return sendQuickQuoteAnalysisResult(
            res,
            result
          );
        } catch {
          return sendQuickQuoteAnalysisRouteFailure(
            res
          );
        }
      }
    );


    app.get(
      QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_ROUTE,
      setIntelligenceNoStore,
      authMiddleware,
      async (req, res) => {
        try {
          const result =
            await analysisReviewedResultService
              .getReviewedResult({
                pool: getPool(req),
                authenticatedActor:
                  req.user,
                sessionId:
                  req.params.sessionId,
              });

          return sendQuickQuoteAnalysisResult(
            res,
            result
          );
        } catch {
          return sendQuickQuoteAnalysisRouteFailure(
            res
          );
        }
      }
    );
  }

  if (typeof app.delete === "function") {
    app.delete(
      QUICK_QUOTE_ANALYSIS_SESSION_ROUTE,
      setIntelligenceNoStore,
      authMiddleware,
      async (req, res) => {
        if (
          !quickQuoteAnalysisDiscardBodyIsEmpty(
            req.body
          )
        ) {
          return res.status(400).json({
            success: false,
            code:
              "QUICK_QUOTE_ANALYSIS_REQUEST_INVALID",
            message:
              "The Job Analysis request is invalid.",
          });
        }

        try {
          const result =
            await analysisSessionService
              .discardSession({
                pool: getPool(req),
                authenticatedActor:
                  req.user,
                sessionId:
                  req.params.sessionId,
                idempotencyKey:
                  req.headers?.[
                    "idempotency-key"
                  ],
              });

          return sendQuickQuoteAnalysisResult(
            res,
            result
          );
        } catch {
          return sendQuickQuoteAnalysisRouteFailure(
            res
          );
        }
      }
    );
  }

  app.post(
    QUICK_QUOTE_ANALYSIS_ANALYZE_ROUTE,
    setIntelligenceNoStore,
    authMiddleware,
    async (req, res) => {
      const execution =
        normalizeQuickQuoteAnalysisExecutionBody(
          req.body,
          {
            continuation: false,
          }
        );

      if (!execution) {
        return res.status(400).json({
          success: false,
          code:
            "QUICK_QUOTE_ANALYSIS_REQUEST_INVALID",
          message:
            "The Job Analysis request is invalid.",
        });
      }

      try {
        const result =
          await analysisContinuationService
            .analyzeSession({
              pool:
                getPool(req),

              authenticatedActor:
                req.user,

              sessionId:
                req.params.sessionId,

              idempotencyKey:
                req.headers?.[
                  "idempotency-key"
                ],

              locale:
                execution.locale,

              providers:
                req.app?.locals
                  ?.intelligenceProviders ||
                dependencies.providers,

              intelligenceRepository:
                dependencies.repository,

              usageFinalizer:
                dependencies.usageFinalizer,

              providerTimeoutMs:
                dependencies.providerTimeoutMs,

              logger:
                dependencies.logger,

              onDiagnostics:
                dependencies.onDiagnostics,
            });

        return sendQuickQuoteAnalysisResult(
          res,
          result
        );
      } catch {
        return sendQuickQuoteAnalysisRouteFailure(
          res
        );
      }
    }
  );

  app.post(
    QUICK_QUOTE_ANALYSIS_CONTINUE_ROUTE,
    setIntelligenceNoStore,
    authMiddleware,
    async (req, res) => {
      const execution =
        normalizeQuickQuoteAnalysisExecutionBody(
          req.body,
          {
            continuation: true,
          }
        );

      if (!execution) {
        return res.status(400).json({
          success: false,
          code:
            "QUICK_QUOTE_ANALYSIS_REQUEST_INVALID",
          message:
            "The Job Analysis request is invalid.",
        });
      }

      try {
        const result =
          await analysisContinuationService
            .continueSession({
              pool:
                getPool(req),

              authenticatedActor:
                req.user,

              sessionId:
                req.params.sessionId,

              priorProposalId:
                execution.priorProposalId,

              message:
                execution.message,

              idempotencyKey:
                req.headers?.[
                  "idempotency-key"
                ],

              locale:
                execution.locale,

              providers:
                req.app?.locals
                  ?.intelligenceProviders ||
                dependencies.providers,

              intelligenceRepository:
                dependencies.repository,

              usageFinalizer:
                dependencies.usageFinalizer,

              providerTimeoutMs:
                dependencies.providerTimeoutMs,

              logger:
                dependencies.logger,

              onDiagnostics:
                dependencies.onDiagnostics,
            });

        return sendQuickQuoteAnalysisResult(
          res,
          result
        );
      } catch {
        return sendQuickQuoteAnalysisRouteFailure(
          res
        );
      }
    }
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
  QUICK_QUOTE_ANALYSIS_ANALYZE_ROUTE,
  QUICK_QUOTE_ANALYSIS_CONTINUE_ROUTE,
  QUICK_QUOTE_ANALYSIS_EVIDENCE_ROUTE,
  QUICK_QUOTE_ANALYSIS_SESSION_COLLECTION_ROUTE,
  QUICK_QUOTE_ANALYSIS_SESSION_ROUTE,
  QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_ROUTE,
  QUOTE_COMPOSITION_FEEDBACK_ROUTE,
  WORKFLOW_REVIEW_ROUTE,
  WORKFLOW_TRANSCRIPTION_ROUTE,
  createIntelligenceGatewayHandler,
  registerIntelligenceRoutes,
  setIntelligenceNoStore,
};
