"use strict";

const { getConnectedServiceProviders } = require("./connectedServicesRegistry");
const {
  CONNECTED_SERVICES_READ_ROLES,
  getConnectedServicesBusinessAuthority,
  connectedServicesBusinessAuthorityInternals,
} = require("./connectedServicesBusinessAuthority");

const { isConnectConfig } = require("./stripeConnectConfig");
const operations = require("./stripeConnectOperationRepository");
const readiness = require("./stripeConnectStateRepository");
const { projectState } = require("./stripeConnectState");

async function getConnectedServices(options = {}) {
  const authority = await getConnectedServicesBusinessAuthority(options);
  if (!authority.ok) return authority;

  const providers = getConnectedServiceProviders();
  const config = options.connectConfig;
  if (config?.enabled === true) {
    let state = { status: "UNAVAILABLE", reason: "CONFIGURATION_INVALID" };
    if (isConnectConfig(config)) {
      const scope = { businessId: authority.business.businessId, environment: config.environment, providerScopeId: config.providerScopeId };
      try {
        const connection = await operations.load(options.pool,scope);
        const cached = connection ? await readiness.load(options.pool,scope,connection.id) : null;
        state = projectState({ enabled: true, connection, operation: connection, readiness: cached, scope, now: options.now });
      } catch { state = { status: "UNAVAILABLE", reason: "CANONICAL_STATE_UNAVAILABLE" }; }
    }
    const i = providers.findIndex(p => p.provider === "STRIPE_PAYMENTS");
    providers[i] = { ...providers[i], ...state };
  }
  return {
    ok: true,
    status: 200,
    code: "CONNECTED_SERVICES_LOADED",
    contractVersion: 1,
    business: authority.business,
    providers,
  };
}

module.exports = {
  CONNECTED_SERVICES_READ_ROLES,
  getConnectedServices,
  connectedServicesServiceInternals: connectedServicesBusinessAuthorityInternals,
};
