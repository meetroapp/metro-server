"use strict";

const teamService = require("./teamService");

function send(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "BUSINESS_TEAM_OPERATION_FAILED",
      message: result?.message || "The Team operation could not be completed.",
    });
  }
  const { ok, status, ...payload } = result;
  return res.status(status || 200).json({ success: true, ...payload });
}

function createTeamHandlers({
  getPool,
  sendPublicDatabaseError,
  service = teamService,
  environment = process.env,
}) {
  const handle = (operation, action) => async (req, res) => {
    res.setHeader?.("Cache-Control", "private, no-store");
    try {
      return send(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "BUSINESS_TEAM_OPERATION_FAILED",
        message: "The Team operation could not be completed.",
      });
    }
  };

  return {
    getMine: handle("get_business_team_authority", (req) => service.getMyTeamAuthority({
      pool: getPool(req),
      authenticatedActor: req.user,
    })),
    list: handle("list_business_team", (req) => service.listTeam({
      pool: getPool(req),
      authenticatedActor: req.user,
      businessId: req.query?.businessId,
      environment,
    })),
    invite: handle("invite_business_team_member", (req) => service.inviteTeamMember({
      pool: getPool(req),
      authenticatedActor: req.user,
      businessId: req.body?.businessId,
      email: req.body?.email,
      displayName: req.body?.displayName,
      role: req.body?.role,
      environment,
    })),
    accept: handle("accept_business_team_invitation", (req) => service.acceptTeamInvitation({
      pool: getPool(req),
      authenticatedActor: req.user,
      token: req.body?.token,
    })),
    revoke: handle("revoke_business_team_invitation", (req) => service.revokeTeamInvitation({
      pool: getPool(req),
      authenticatedActor: req.user,
      businessId: req.body?.businessId,
      invitationId: req.params?.invitationId,
    })),
    updateRole: handle("update_business_team_role", (req) => service.updateTeamMemberRole({
      pool: getPool(req),
      authenticatedActor: req.user,
      businessId: req.body?.businessId,
      membershipId: req.params?.membershipId,
      role: req.body?.role,
    })),
    deactivate: handle("deactivate_business_team_member", (req) => service.deactivateTeamMember({
      pool: getPool(req),
      authenticatedActor: req.user,
      businessId: req.body?.businessId,
      membershipId: req.params?.membershipId,
    })),
  };
}

function registerTeamRoutes(options) {
  const { app, authMiddleware } = options;
  if (!app || typeof authMiddleware !== "function") {
    throw new TypeError("Business Team route dependencies are required.");
  }
  const handlers = createTeamHandlers(options);
  app.get("/team/me", authMiddleware, handlers.getMine);
  app.get("/team", authMiddleware, handlers.list);
  app.post("/team/invitations", authMiddleware, handlers.invite);
  app.post("/team/invitations/accept", authMiddleware, handlers.accept);
  app.post("/team/invitations/:invitationId/revoke", authMiddleware, handlers.revoke);
  app.patch("/team/members/:membershipId/role", authMiddleware, handlers.updateRole);
  app.post("/team/members/:membershipId/deactivate", authMiddleware, handlers.deactivate);
  return handlers;
}

module.exports = {
  createTeamHandlers,
  registerTeamRoutes,
  send,
};
