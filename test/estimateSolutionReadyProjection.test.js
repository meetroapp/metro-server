"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildReviewedEstimateProjection,
} = require("../server/intelligence/estimateSolutionReadyService");

const PROPOSAL_ID =
  "10000000-0000-4000-8000-000000000601";

const JOB_ID =
  "20000000-0000-4000-8000-000000000601";

function estimateProposal() {
  return {
    schemaVersion: 1,
    proposalId: PROPOSAL_ID,
    authorityClassification:
      "INTERNAL_ESTIMATE_DRAFT_NON_CANONICAL",
    jobId: JOB_ID,
    sourceContextFingerprint:
      "a".repeat(64),
    summary:
      "Private internal estimate.",
    materials: [
      {
        id: "drywall_material",
        description:
          "Drywall and finishing material",
        quantity: 1,
        unit: "lot",
        wastePercent: 0,
        professionalOverride: null,
        retailerReference: {
          id: "retailer_drywall",
          retailer: "HOME_DEPOT",
          listedPriceMinor: 4000,
          customerVisibleByDefault: false,
        },
        effectiveUnitCostMinor: 4000,
        estimatedCostMinor: 4000,
        priceProvenance:
          "RETAILER_REFERENCE",
        assumption: "",
        needsVerification: false,
        customerVisibleByDefault: false,
      },
    ],
    labor: [
      {
        id: "repair_labor",
        description:
          "Repair wall and relocate outlet",
        crewCount: 1,
        hoursPerWorker: 4,
        professionalOverride: {
          key: "labor_0",
          classification: "LABOR",
          description: "Labor",
          quantity: 1,
          unitCostMinor: 26000,
          provenance:
            "PROFESSIONAL_OVERRIDE",
        },
        estimatedCostMinor: 104000,
        assumption:
          "Existing wiring remains serviceable.",
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
      rationale:
        "Advisory range only.",
      authorityClassification:
        "ADVISORY",
    },
    professionalSellingPriceMinor: 42000,
    assumptions: [
      {
        id: "verify_cavity",
        text:
          "Verify wall cavity before relocating outlet.",
        classification:
          "NEEDS_VERIFICATION",
      },
    ],
    missingInformation: [],
    retailerReferences: [],
    customerQuoteDraft: {
      id: "customer_quote_draft",
      scopeSummary:
        "Repair the closet wall and relocate the outlet.",
      conditions: [],
      exclusions: [],
      durationGuidance:
        "Approximately one working day.",
      customerWording:
        "Repair wall inside closet, relocate outlet to living room wall, and install a new outlet plate.",
    },
    warnings: [],
    reviewContract: {
      actions: [
        "ACCEPTED",
        "EDITED",
        "REJECTED",
      ],
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

test(
  "reviewed estimate projection preserves provenance and never promotes advisory or internal pricing",
  () => {
    const projection =
      buildReviewedEstimateProjection({
        proposal: estimateProposal(),
        reviewRows: [
          {
            proposal_element_id:
              "drywall_material",
            action: "ACCEPTED",
            edited_value: null,
          },
          {
            proposal_element_id:
              "repair_labor",
            action: "REJECTED",
            edited_value: null,
          },
          {
            proposal_element_id:
              "customer_quote_draft",
            action: "ACCEPTED",
            edited_value: null,
          },
        ],
      });

    assert.ok(projection);

    assert.equal(
      projection.authorityClassification,
      "REVIEWED_INTERNAL_ESTIMATE_NON_CANONICAL"
    );

    assert.equal(
      projection.sourceProposalAuthorityClassification,
      "INTERNAL_ESTIMATE_DRAFT_NON_CANONICAL"
    );

    assert.equal(
      projection.canonicalMutationPerformed,
      false
    );

    assert.deepEqual(
      projection.reviewedElementIds,
      [
        "customer_quote_draft",
        "drywall_material",
      ]
    );

    assert.deepEqual(
      projection.rejectedElementIds,
      ["repair_labor"]
    );

    assert.deepEqual(
      projection.unreviewedElementIds,
      ["verify_cavity"]
    );

    assert.equal(
      projection.reviewed.materials.length,
      1
    );

    assert.equal(
      projection.reviewed.materials[0]
        .priceProvenance,
      "RETAILER_REFERENCE"
    );

    assert.equal(
      projection.reviewed.materials[0]
        .effectiveUnitCostMinor,
      4000
    );

    assert.equal(
      projection.reviewed.labor.length,
      0
    );

    assert.equal(
      projection.reviewed.customerQuoteDraft
        .customerWording,
      "Repair wall inside closet, relocate outlet to living room wall, and install a new outlet plate."
    );

    assert.equal(
      projection.professionalSellingPriceMinor,
      42000
    );

    assert.equal(
      projection.suggestedSellingRange
        .authorityClassification,
      "ADVISORY"
    );

    const serialized =
      JSON.stringify(projection);

    assert.doesNotMatch(
      serialized,
      /canonicalCandidate/
    );

    assert.doesNotMatch(
      serialized,
      /pricingInputs/
    );
  }
);

test(
  "latest durable review decision wins and unknown review rows grant no trust",
  () => {
    const projection =
      buildReviewedEstimateProjection({
        proposal: estimateProposal(),
        reviewRows: [
          {
            proposal_element_id:
              "drywall_material",
            action: "ACCEPTED",
            edited_value: null,
          },
          {
            proposal_element_id:
              "unknown_element",
            action: "ACCEPTED",
            edited_value: null,
          },
          {
            proposal_element_id:
              "drywall_material",
            action: "REJECTED",
            edited_value: null,
          },
          {
            proposal_element_id:
              "customer_quote_draft",
            action: "ACCEPTED",
            edited_value: null,
          },
          {
            proposal_element_id:
              "verify_cavity",
            action: "ACCEPTED",
            edited_value: null,
          },
        ],
      });

    assert.ok(projection);

    assert.deepEqual(
      projection.reviewedElementIds,
      [
        "customer_quote_draft",
        "verify_cavity",
      ]
    );

    assert.deepEqual(
      projection.rejectedElementIds,
      ["drywall_material"]
    );

    assert.deepEqual(
      projection.unreviewedElementIds,
      ["repair_labor"]
    );

    assert.equal(
      projection.reviewed.materials.length,
      0
    );

    assert.equal(
      projection.reviewed.assumptions.length,
      1
    );
  }
);

test(
  "projection rejects a proposal that claims canonical Estimate authority",
  () => {
    const proposal =
      estimateProposal();

    proposal.authorityClassification =
      "CANONICAL";

    assert.equal(
      buildReviewedEstimateProjection({
        proposal,
        reviewRows: [],
      }),
      null
    );
  }
);

test(
  "edited Estimate review cannot silently promote the original AI value",
  () => {
    const projection =
      buildReviewedEstimateProjection({
        proposal: estimateProposal(),
        reviewRows: [
          {
            proposal_element_id:
              "drywall_material",
            action: "EDITED",
            edited_value: {
              description:
                "Professional-edited material description",
            },
          },
        ],
      });

    /*
     * Until R1-06 defines an explicit field-level edit
     * allowlist, an EDITED review must fail closed.
     * It may never be treated as acceptance of the
     * original AI proposal value.
     */
    assert.equal(
      projection,
      null
    );
  }
);
