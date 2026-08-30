"use strict";

const {
  Environment,
  SignedDataVerifier,
} = require("@apple/app-store-server-library");

function environmentValue(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "PRODUCTION") return Environment.PRODUCTION;
  if (normalized === "XCODE") return Environment.XCODE;
  return Environment.SANDBOX;
}

function decodeRootCertificates(value) {
  const values = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  return values.map((item) => Buffer.from(item, "base64")).filter((item) => item.length > 0);
}

function createAppleSubscriptionVerifier(environment = process.env) {
  const bundleId = String(environment.APPLE_BUNDLE_ID || "").trim();
  const roots = decodeRootCertificates(environment.APPLE_ROOT_CA_BASE64);
  const providerEnvironment = environmentValue(environment.APPLE_SUBSCRIPTION_ENVIRONMENT);
  const appAppleId = environment.APPLE_APP_ID ? Number(environment.APPLE_APP_ID) : undefined;
  const production = providerEnvironment === Environment.PRODUCTION;

  if (!bundleId || roots.length === 0 || (production && !Number.isSafeInteger(appAppleId))) {
    return {
      configured: false,
      providerEnvironment,
      async verifyTransaction() {
        const error = new Error("Apple subscription verification is not configured.");
        error.code = "APPLE_SERVER_CONFIGURATION_REQUIRED";
        throw error;
      },
      async verifyRenewalInfo() {
        return null;
      },
      async verifyNotification() {
        const error = new Error("Apple subscription verification is not configured.");
        error.code = "APPLE_SERVER_CONFIGURATION_REQUIRED";
        throw error;
      },
    };
  }

  const verifier = new SignedDataVerifier(
    roots,
    true,
    providerEnvironment,
    bundleId,
    production ? appAppleId : undefined
  );
  return {
    configured: true,
    providerEnvironment,
    verifyTransaction: (signedData) => verifier.verifyAndDecodeTransaction(signedData),
    verifyRenewalInfo: (signedData) => signedData
      ? verifier.verifyAndDecodeRenewalInfo(signedData)
      : Promise.resolve(null),
    verifyNotification: (signedData) => verifier.verifyAndDecodeNotification(signedData),
  };
}

module.exports = {
  createAppleSubscriptionVerifier,
  decodeRootCertificates,
  environmentValue,
};
