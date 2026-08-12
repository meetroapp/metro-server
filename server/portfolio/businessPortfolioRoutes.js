"use strict";

const { rejectUnsupportedMedia } = require("../media/mediaReferencePolicy");
const portfolioAuthorityService = require("./businessPortfolioAuthorityService");

function sendPortfolioResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "BUSINESS_PORTFOLIO_COMMAND_FAILED",
      message: result?.message || "The Portfolio command could not be completed.",
    });
  }

  const body = {};
  if (result.code) {
    body.success = true;
    body.code = result.code;
  }
  if (result.project) body.project = result.project;
  if (result.projects) body.projects = result.projects;
  if (result.unfeatured_project_ids) {
    body.unfeatured_project_ids = result.unfeatured_project_ids;
  }
  if (result.unfeatured_projects) {
    body.unfeatured_projects = result.unfeatured_projects;
  }
  return res.status(result.status || 200).json(body);
}

function createBusinessPortfolioHandlers({
  getPool,
  sendPublicDatabaseError,
  service = portfolioAuthorityService,
  env = process.env,
} = {}) {
  const handle = (operation, action, { preflight = null } = {}) => async (req, res) => {
    if (typeof res.setHeader === "function" && req.user) {
      res.setHeader("Cache-Control", "private, no-store");
    }
    if (preflight?.(req, res)) return;
    try {
      return sendPortfolioResult(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "BUSINESS_PORTFOLIO_COMMAND_FAILED",
        message: "The Portfolio command could not be completed.",
      });
    }
  };

  const commandContext = (req) => ({
    pool: getPool(req),
    authenticatedActor: req.user,
    projectId: req.params.id,
    payload: req.body,
  });

  return {
    createProject: handle(
      "create_portfolio_project",
      (req) => service.createPortfolioProject({
        pool: getPool(req),
        authenticatedActor: req.user,
        payload: req.body,
        env,
        mediaService: req.app?.locals?.cloudinaryMedia || null,
      }),
      {
        preflight: (req, res) =>
          rejectUnsupportedMedia(req, res, ["image_url", "image_urls"]),
      }
    ),
    updateProject: handle(
      "update_portfolio_project",
      (req) => service.updatePortfolioProject({
        ...commandContext(req),
        env,
        mediaService: req.app?.locals?.cloudinaryMedia || null,
      }),
      {
        preflight: (req, res) =>
          rejectUnsupportedMedia(req, res, ["image_url", "image_urls"]),
      }
    ),
    adoptLegacyProject: handle("adopt_legacy_portfolio_project", (req) =>
      service.adoptLegacyPortfolioProject(commandContext(req))
    ),
    publishProject: handle("publish_portfolio_project", (req) =>
      service.publishPortfolioProject(commandContext(req))
    ),
    archiveProject: handle("archive_portfolio_project", (req) =>
      service.archivePortfolioProject(commandContext(req))
    ),
    featureProject: handle("feature_portfolio_project", (req) =>
      service.setPortfolioFeature({ ...commandContext(req), featured: true })
    ),
    unfeatureProject: handle("unfeature_portfolio_project", (req) =>
      service.setPortfolioFeature({ ...commandContext(req), featured: false })
    ),
    reorderProjects: handle("reorder_portfolio_projects", (req) =>
      service.reorderPortfolioProjects({
        pool: getPool(req),
        authenticatedActor: req.user,
        payload: req.body,
      })
    ),
    listOwnedProjects: handle("fetch_owned_contractor_projects", (req) =>
      service.listOwnedPortfolioProjects({
        pool: getPool(req),
        authenticatedActor: req.user,
      })
    ),
    listPublicProjects: handle("fetch_contractor_projects", (req) =>
      service.listPublicPortfolioProjects({
        pool: getPool(req),
        contractorId: req.params.contractorId,
      })
    ),
  };
}

function registerBusinessPortfolioRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = portfolioAuthorityService,
  env = process.env,
} = {}) {
  const handlers = createBusinessPortfolioHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
    env,
  });

  app.post("/contractor-projects", authMiddleware, handlers.createProject);
  app.put("/contractor-projects/reorder", authMiddleware, handlers.reorderProjects);
  app.put("/contractor-projects/:id", authMiddleware, handlers.updateProject);
  app.post(
    "/contractor-projects/:id/legacy-adoption",
    authMiddleware,
    handlers.adoptLegacyProject
  );
  app.post("/contractor-projects/:id/publish", authMiddleware, handlers.publishProject);
  app.post("/contractor-projects/:id/archive", authMiddleware, handlers.archiveProject);
  app.post("/contractor-projects/:id/feature", authMiddleware, handlers.featureProject);
  app.post("/contractor-projects/:id/unfeature", authMiddleware, handlers.unfeatureProject);
  app.get("/my-contractor-projects", authMiddleware, handlers.listOwnedProjects);
  app.get("/contractor-projects/:contractorId", handlers.listPublicProjects);

  return handlers;
}

module.exports = {
  createBusinessPortfolioHandlers,
  registerBusinessPortfolioRoutes,
  sendPortfolioResult,
};
