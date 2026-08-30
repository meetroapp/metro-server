"use strict";

const { createHash } = require("node:crypto");
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

function normalizeTeamInvitationClientBaseUrl(environment = process.env) {
  const raw = String(
    environment?.TEAM_INVITATION_CLIENT_BASE_URL || ""
  ).trim();

  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    if (!["https:", "http:"].includes(parsed.protocol)) return "";
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${path}`;
  } catch {
    return "";
  }
}

function buildTeamInvitationJoinUrl(invitation, environment = process.env) {
  const token = String(invitation?.token || "").trim();
  const baseUrl = normalizeTeamInvitationClientBaseUrl(environment);
  if (!token || !baseUrl) return "";
  return `${baseUrl}/login#teamMembers?invitation=${encodeURIComponent(token)}`;
}

function invitationDeliveryIdempotencyKey(invitation) {
  const token = String(invitation?.token || "").trim();
  if (!token || !invitation?.id) return "";
  const tokenFingerprint = createHash("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 24);
  return `team-invitation:${invitation.id}:${tokenFingerprint}`;
}

async function attachTeamInvitationDelivery({
  result,
  emailDelivery,
  environment,
}) {
  if (!result?.ok || !result?.invitation) return result;

  const invitation = result.invitation;
  const joinUrl = buildTeamInvitationJoinUrl(invitation, environment);

  let delivery = {
    accepted: false,
    status: joinUrl
      ? "provider_not_configured"
      : "client_base_url_not_configured",
  };

  if (
    joinUrl &&
    typeof emailDelivery?.sendTeamInvitationEmail === "function"
  ) {
    try {
      delivery = await emailDelivery.sendTeamInvitationEmail({
        recipientEmail: invitation.email,
        businessName: invitation.businessName,
        role: invitation.role,
        joinUrl,
        idempotencyKey: invitationDeliveryIdempotencyKey(invitation),
      });
    } catch {
      delivery = {
        accepted: false,
        status: "provider_unavailable",
      };
    }
  }

  return {
    ...result,
    invitation: {
      ...invitation,
      ...(joinUrl ? { joinUrl } : {}),
      emailDeliveryStatus: delivery?.accepted ? "sent" : "failed",
      emailDelivery: {
        accepted: Boolean(delivery?.accepted),
        status: String(delivery?.status || "unknown"),
      },
    },
  };
}

function createTeamHandlers({
  getPool,
  sendPublicDatabaseError,
  service = teamService,
  environment = process.env,
  emailDelivery,
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
    inspect: handle("inspect_business_team_invitation", (req) =>
      service.inspectTeamInvitation({
        pool: getPool(req),
        token: req.body?.token,
      })
    ),
    invite: handle("invite_business_team_member", async (req) =>
      attachTeamInvitationDelivery({
        result: await service.inviteTeamMember({
          pool: getPool(req),
          authenticatedActor: req.user,
          businessId: req.body?.businessId,
          email: req.body?.email,
          displayName: req.body?.displayName,
          role: req.body?.role,
          environment,
        }),
        emailDelivery,
        environment,
      })
    ),
    resend: handle("resend_business_team_invitation", async (req) =>
      attachTeamInvitationDelivery({
        result: await service.resendTeamInvitation({
          pool: getPool(req),
          authenticatedActor: req.user,
          businessId: req.body?.businessId,
          invitationId: req.params?.invitationId,
        }),
        emailDelivery,
        environment,
      })
    ),
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

  // Invitation inspection is intentionally unauthenticated and read-only.
  // The high-entropy invitation token is required; no Team authority is mutated.
  app.post("/team/invitations/inspect", handlers.inspect);

  app.get("/team/me", authMiddleware, handlers.getMine);
  app.get("/team", authMiddleware, handlers.list);
  app.post("/team/invitations", authMiddleware, handlers.invite);
  app.post("/team/invitations/accept", authMiddleware, handlers.accept);
  app.post("/team/invitations/:invitationId/resend", authMiddleware, handlers.resend);
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
