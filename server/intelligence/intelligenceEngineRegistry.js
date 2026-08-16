"use strict";

const {
  jobRequestInterpretEngines,
} = require("./operations/jobRequestInterpret");
const {
  quoteComposeEngines,
} = require("./operations/quoteCompose");
const {
  workflowAssistEngines,
} = require("./operations/workflowAssist");

function createIntelligenceEngineRegistry(engines = []) {
  const registry = new Map();
  for (const engine of engines) {
    const id = String(engine?.id || "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(id) || typeof engine?.collectContext !== "function") {
      throw new TypeError("Invalid Intelligence engine definition.");
    }
    if (registry.has(id)) throw new Error(`Duplicate Intelligence engine: ${id}`);
    registry.set(id, Object.freeze({ id, collectContext: engine.collectContext }));
  }

  return Object.freeze({
    get(id) {
      return registry.get(String(id || "").trim().toLowerCase()) || null;
    },
    list() {
      return [...registry.keys()].sort();
    },
  });
}

const canonicalIntelligenceEngineRegistry = createIntelligenceEngineRegistry(
  [...jobRequestInterpretEngines, ...quoteComposeEngines, ...workflowAssistEngines]
);

module.exports = {
  canonicalIntelligenceEngineRegistry,
  createIntelligenceEngineRegistry,
};
