"use strict";

const { getConnectedServiceProviders } = require("./connectedServicesRegistry");
const {
  CONNECTED_SERVICES_READ_ROLES,
  getConnectedServicesBusinessAuthority,
  connectedServicesBusinessAuthorityInternals,
} = require("./connectedServicesBusinessAuthority");

async function getConnectedServices(options = {}) {
  const authority = await getConnectedServicesBusinessAuthority(options);
  if (!authority.ok) return authority;

  // R2 remains a registry projection; internal connection persistence is not read.
  return {
    ok: true,
    status: 200,
    code: "CONNECTED_SERVICES_LOADED",
    contractVersion: 1,
    business: authority.business,
    providers: getConnectedServiceProviders(),
  };
}

module.exports = {
  CONNECTED_SERVICES_READ_ROLES,
  getConnectedServices,
  connectedServicesServiceInternals: connectedServicesBusinessAuthorityInternals,
};
