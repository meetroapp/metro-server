"use strict";

function createProviderRegistry(providers = {}) {
  const registry = new Map();
  for (const [key, provider] of Object.entries(providers || {})) {
    const name = String(provider?.name || key).trim().toLowerCase();
    if (!name || typeof provider?.complete !== "function") continue;
    registry.set(name, provider);
  }
  return registry;
}

function providerFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

async function invokeIntelligenceProvider({
  providerName = "default",
  providers,
  request,
  timeoutMs = 15000,
  onInvoke,
}) {
  const provider = createProviderRegistry(providers).get(
    String(providerName).trim().toLowerCase()
  );
  if (!provider) {
    throw providerFailure(
      "provider_unavailable",
      "The configured Intelligence provider is unavailable."
    );
  }

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(providerFailure("provider_timeout", "The Intelligence provider timed out.")),
      Math.max(1, Math.min(Number(timeoutMs) || 15000, 30000))
    );
  });

  try {
    onInvoke?.();
    return await Promise.race([provider.complete(request), timeout]);
  } catch (error) {
    if (error?.code) throw error;
    throw providerFailure("provider_failure", "The Intelligence provider failed.");
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  createProviderRegistry,
  invokeIntelligenceProvider,
};
