"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createEstimateSolutionReadyService,
} = require("../server/intelligence/estimateSolutionReadyService");

const PROPOSAL_ID =
  "10000000-0000-4000-8000-000000000701";

const JOB_ID =
  "20000000-0000-4000-8000-000000000701";

const ACTOR = {
  id: 73,
  role: "professional",
  accountType: "professional",
};

function proposal() {
  return {
    schemaVersion: 1,
    proposalId: PROPOSAL_ID,
    authorityClassification:
      "INTERNAL_ESTIMATE_DRAFT_NON_CANONICAL",
    jobId: JOB_ID,
    sourceContextFingerprint:
      "b".repeat(64),
    summary: "Private reviewed estimate fixture.",
    materials: [
      {
        id: "wall_material",
        description: "Wall repair materials",
        quantity: 1,
        unit: "lot",
        wastePercent: 0,
        professionalOverride: null,
        retailerReference: {
          id: "retailer_wall_material",
          retailer: "HOME_DEPOT",
          listedPriceMinor: 4000,
          customerVisibleByDefault: false,
        },
        effectiveUnitCostMinor: 4000,
        estimatedCostMinor: 4000,
        priceProvenance: "RETAILER_REFERENCE",
        assumption: "",
        needsVerification: false,
        customerVisibleByDefault: false,
      },
    ],
    labor: [
      {
        id: "wall_labor",
        description: "Repair wall and relocate outlet",
        crewCount: 1,
        hoursPerWorker: 4,
        professionalOverride: {
          key: "labor_0",
          classification: "LABOR",
          description: "Labor",
          quantity: 1,
          unitCostMinor: 26000,
          provenance: "PROFESSIONAL_OVERRIDE",
        },
        estimatedCostMinor: 104000,
        assumption: "",
        needsProfessionalAcceptance: true,
        customerVisibleByDefault: false,
      },
    ],
    equipment: [],
    disposal: {
      description: "",
      professionalOverride: null,
      estimatedCostMinor: null,
      customerVisibleByDefault: false,
    },
    contingency: {
      percent: 0,
      amountMinor: 0,
    },
    internalCost: {
      currency: "USD",
      materialsMinor: 4000,
      laborMinor: 104000,
      equipmentMinor: 0,
      disposalMinor: 0,
      contingencyMinor: 0,
      totalMinor: 108000,
      customerVisible: false,
    },
    suggestedSellingRange: {
      minimumMinor: 35000,
      maximumMinor: 45000,
      rationale: "AI advisory range.",
      authorityClassification: "ADVISORY",
    },
    professionalSellingPriceMinor: 42000,
    assumptions: [],
    missingInformation: [],
    retailerReferences: [],
    customerQuoteDraft: {
      id: "customer_quote_draft",
      scopeSummary:
        "Repair wall and relocate outlet.",
      conditions: [],
      exclusions: [],
      durationGuidance: "One working day.",
      customerWording:
        "Repair the wall, relocate the outlet, and install a new outlet plate.",
    },
    warnings: [],
    reviewContract: {
      actions: ["ACCEPTED", "EDITED", "REJECTED"],
      explicitProfessionalDecisionRequired: true,
    },
    humanToCanonicalBoundary: {
      directMutationAllowed: false,
      requiredCanonicalCommands: [
        "quote.draft.create",
        "quote.scope.add",
      ],
      prohibitedCanonicalCommands: [
        "quote.issue",
        "quote.customer.approve",
        "quote.customer.decline",
      ],
    },
  };
}

function serviceFixture({
  storedProposal = proposal(),
  authorized = true,
} = {}) {
  const calls = [];

  const persistence = {
    async withReadTransaction(_pool, work) {
      calls.push(["transaction"]);
      return work({});
    },

    async loadCompletedEstimateProposal(
      _client,
      { proposalId, actorUserId }
    ) {
      calls.push([
        "proposal",
        proposalId,
        actorUserId,
      ]);

      if (
        proposalId !== PROPOSAL_ID ||
        actorUserId !== ACTOR.id
      ) {
        return null;
      }

      return storedProposal;
    },

    async loadEstimateReviews(
      _client,
      { proposalId, actorUserId }
    ) {
      calls.push([
        "reviews",
        proposalId,
        actorUserId,
      ]);

      return [
        {
          proposal_element_id: "wall_material",
          action: "ACCEPTED",
          edited_value: null,
        },
        {
          proposal_element_id: "wall_labor",
          action: "REJECTED",
          edited_value: null,
        },
        {
          proposal_element_id:
            "customer_quote_draft",
          action: "ACCEPTED",
          edited_value: null,
        },
      ];
    },
  };

  const service =
    createEstimateSolutionReadyService({
      persistence,

      async loadAuthorizedJob(
        _client,
        jobId,
        actorUserId
      ) {
        calls.push([
          "authority",
          jobId,
          actorUserId,
        ]);

        if (
          !authorized ||
          jobId !== JOB_ID ||
          actorUserId !== ACTOR.id
        ) {
          const error =
            new Error(
              "Professional Quote authority required."
            );
          error.code =
            "intelligence_quote_authority_required";
          throw error;
        }

        return {
          job_id: JOB_ID,
          professional_participant_id:
            "30000000-0000-4000-8000-000000000701",
        };
      },
    });

  return {
    service,
    calls,
  };
}

const pool = {
  async connect() {
    throw new Error(
      "Injected persistence owns the read transaction."
    );
  },
};

test(
  "Solution Ready context is derived only from the actor-owned completed Estimate and durable reviews",
  async () => {
    const {
      service,
      calls,
    } = serviceFixture();

    const result =
      await service.prepareReviewedEstimate({
        pool,
        authenticatedActor: ACTOR,
        proposalId: PROPOSAL_ID,
      });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(
      result.code,
      "ESTIMATE_SOLUTION_READY_CONTEXT_PREPARED"
    );

    assert.equal(
      result.canonicalMutationPerformed,
      false
    );

    assert.equal(
      result.reviewedEstimate
        .authorityClassification,
      "REVIEWED_INTERNAL_ESTIMATE_NON_CANONICAL"
    );

    assert.equal(
      result.reviewedEstimate.jobId,
      JOB_ID
    );

    assert.deepEqual(
      result.reviewedEstimate.reviewedElementIds,
      [
        "customer_quote_draft",
        "wall_material",
      ]
    );

    assert.deepEqual(
      result.reviewedEstimate.rejectedElementIds,
      ["wall_labor"]
    );

    assert.equal(
      result.reviewedEstimate
        .reviewed.materials[0]
        .priceProvenance,
      "RETAILER_REFERENCE"
    );

    assert.equal(
      result.reviewedEstimate
        .professionalSellingPriceMinor,
      42000
    );

    assert.equal(
      result.reviewedEstimate
        .suggestedSellingRange
        .authorityClassification,
      "ADVISORY"
    );

    assert.deepEqual(
      calls.map((item) => item[0]),
      [
        "transaction",
        "proposal",
        "authority",
        "reviews",
      ]
    );

    assert.doesNotMatch(
      JSON.stringify(result),
      /canonicalCandidate|pricingInputs/
    );
  }
);

test(
  "Solution Ready context rejects an unavailable or foreign Estimate proposal",
  async () => {
    const {
      service,
    } = serviceFixture();

    const result =
      await service.prepareReviewedEstimate({
        pool,
        authenticatedActor: ACTOR,
        proposalId:
          "10000000-0000-4000-8000-000000000799",
      });

    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.equal(
      result.code,
      "ESTIMATE_SOLUTION_READY_PROPOSAL_UNAVAILABLE"
    );
  }
);

test(
  "Solution Ready context fails closed when current professional Quote authority is absent",
  async () => {
    const {
      service,
    } = serviceFixture({
      authorized: false,
    });

    const result =
      await service.prepareReviewedEstimate({
        pool,
        authenticatedActor: ACTOR,
        proposalId: PROPOSAL_ID,
      });

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(
      result.code,
      "ESTIMATE_SOLUTION_READY_AUTHORITY_REQUIRED"
    );
  }
);

test(
  "Solution Ready context rejects unauthenticated callers before reading Estimate data",
  async () => {
    const {
      service,
      calls,
    } = serviceFixture();

    const result =
      await service.prepareReviewedEstimate({
        pool,
        authenticatedActor: null,
        proposalId: PROPOSAL_ID,
      });

    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(
      result.code,
      "ESTIMATE_SOLUTION_READY_AUTHENTICATION_REQUIRED"
    );

    assert.deepEqual(calls, []);
  }
);

test(
  "Solution Ready context rejects a malformed or authority-escalating stored Estimate",
  async () => {
    const malformed =
      proposal();

    malformed.authorityClassification =
      "CANONICAL";

    const {
      service,
    } = serviceFixture({
      storedProposal: malformed,
    });

    const result =
      await service.prepareReviewedEstimate({
        pool,
        authenticatedActor: ACTOR,
        proposalId: PROPOSAL_ID,
      });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(
      result.code,
      "ESTIMATE_SOLUTION_READY_CONTEXT_INVALID"
    );
  }
);
