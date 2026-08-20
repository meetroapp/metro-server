"use strict";

const assert =
  require("node:assert/strict");
const test =
  require("node:test");

const {
  buildQuoteComposeContext,
} = require(
  "../server/intelligence/operations/quoteCompose"
);

const IDS = {
  job:
    "10000000-0000-4000-8000-000000001001",
  participant:
    "20000000-0000-4000-8000-000000001001",
  estimate:
    "30000000-0000-4000-8000-000000001001",
};

function contextPool() {
  const calls = [];

  return {
    calls,

    async query(sql) {
      const text =
        String(sql);

      calls.push(text);

      if (
        text.includes(
          "quote_composition:job_authority"
        )
      ) {
        return {
          rows: [
            {
              job_id: IDS.job,
              job_request_id: 14,
              lifecycle_contract_version: 2,
              title:
                "Closet wall repair",
              description:
                "Repair wall and relocate outlet.",
              request_category:
                "home_repair",
              service_domain:
                "home_services",
              service_specialty:
                "drywall",
              homeowner_user_id: 8,
              relationship_id: 3,
              relationship_status:
                "active",
              selected_professional_user_id:
                65,
              actor_account_type:
                "professional",
              professional_participant_id:
                IDS.participant,
              is_primary_professional:
                true,
              active_quote_capabilities: [
                "quote.create",
                "quote.read",
                "quote.scope.manage",
              ],
            },
          ],
        };
      }

      if (
        text.includes(
          "quote_composition:evaluation"
        )
      ) {
        return {
          rows: [],
        };
      }

      return {
        rows: [],
      };
    },
  };
}

function reviewedEstimate() {
  return {
    schemaVersion: 1,
    proposalId:
      IDS.estimate,
    jobId:
      IDS.job,
    authorityClassification:
      "REVIEWED_INTERNAL_ESTIMATE_NON_CANONICAL",
    sourceProposalAuthorityClassification:
      "INTERNAL_ESTIMATE_DRAFT_NON_CANONICAL",

    reviewed: {
      materials: [
        {
          id:
            "wall_material",
          description:
            "Drywall and finishing material",
          quantity: 1,
          unit: "lot",
          wastePercent: 0,

          /*
           * These fields prove the Quote bridge must
           * strip private/reference pricing data.
           */
          retailerReference: {
            id:
              "private_retailer_reference",
            retailer:
              "HOME_DEPOT",
            listedPriceMinor:
              4000,
            customerVisibleByDefault:
              false,
          },

          effectiveUnitCostMinor:
            4000,
          estimatedCostMinor:
            4000,
          priceProvenance:
            "RETAILER_REFERENCE",
          needsVerification:
            false,
          customerVisibleByDefault:
            false,
        },
      ],

      labor: [
        {
          id:
            "repair_labor",
          description:
            "Repair wall and relocate outlet",
          crewCount: 1,
          hoursPerWorker: 4,

          professionalOverride: {
            key:
              "private_labor_cost",
            classification:
              "LABOR",
            unitCostMinor:
              26000,
            provenance:
              "PROFESSIONAL_OVERRIDE",
          },

          estimatedCostMinor:
            104000,
          assumption:
            "Existing wiring remains serviceable.",
          customerVisibleByDefault:
            false,
        },
      ],

      equipment: [],

      assumptions: [
        {
          id:
            "verify_cavity",
          text:
            "Verify concealed wall conditions before final installation.",
          classification:
            "NEEDS_VERIFICATION",
        },
      ],

      customerQuoteDraft: {
        id:
          "customer_quote_draft",
        scopeSummary:
          "Repair wall and relocate outlet.",
        conditions: [],
        exclusions: [],
        durationGuidance:
          "Approximately one working day.",
        customerWording:
          "Repair the closet wall, relocate the outlet to the living room wall, and install a new outlet plate.",
      },
    },

    reviewedElementIds: [
      "customer_quote_draft",
      "repair_labor",
      "verify_cavity",
      "wall_material",
    ],

    rejectedElementIds: [],
    unreviewedElementIds: [],

    internalCost: {
      currency: "USD",
      materialsMinor: 4000,
      laborMinor: 104000,
      totalMinor: 108000,
      customerVisible: false,
    },

    suggestedSellingRange: {
      minimumMinor: 35000,
      maximumMinor: 45000,
      rationale:
        "AI advisory selling range.",
      authorityClassification:
        "ADVISORY",
    },

    professionalSellingPriceMinor:
      42000,

    humanToCanonicalBoundary: {
      directMutationAllowed:
        false,
      quoteCompositionRequiresExplicitProfessionalAction:
        true,
    },

    canonicalMutationPerformed:
      false,
  };
}

test(
  "Solution Ready Quote context is server-derived and strips all private or advisory Estimate pricing",
  async () => {
    const pool =
      contextPool();

    const solutionReadyCalls =
      [];

    const context =
      await buildQuoteComposeContext({
        context: {},

        input: {
          jobId:
            IDS.job,
          mode:
            "ADVISORY",

          /*
           * The browser may identify the reviewed
           * Estimate only. It cannot submit the
           * reviewed projection itself.
           */
          estimateProposalId:
            IDS.estimate,

          professionalInstructions:
            "Prepare the reviewed solution for Quote review.",

          /*
           * No customer Quote pricing was confirmed
           * in this request.
           */
          pricingInputs: [],
          materialInputs: [],
          terms: {},
        },

        runtimeContext: {
          pool,

          authenticatedActor: {
            id: 65,
            role:
              "professional",
          },

          estimateSolutionReadyService: {
            async prepareReviewedEstimate(
              input
            ) {
              solutionReadyCalls.push(
                input
              );

              return {
                ok: true,
                status: 200,
                code:
                  "ESTIMATE_SOLUTION_READY_CONTEXT_PREPARED",
                reviewedEstimate:
                  reviewedEstimate(),
                canonicalMutationPerformed:
                  false,
              };
            },
          },
        },
      });

    assert.equal(
      solutionReadyCalls.length,
      1
    );

    assert.equal(
      solutionReadyCalls[0]
        .proposalId,
      IDS.estimate
    );

    assert.equal(
      solutionReadyCalls[0]
        .authenticatedActor.id,
      65
    );

    assert.equal(
      context.job.id,
      IDS.job
    );

    assert.equal(
      context.reviewedEstimate
        .authorityClassification,
      "REVIEWED_INTERNAL_ESTIMATE_NON_CANONICAL"
    );

    assert.equal(
      context.reviewedEstimate
        .pricingAuthority,
      "PROFESSIONAL_INPUT_ONLY"
    );

    assert.equal(
      context.reviewedEstimate
        .reviewedScope
        .materials[0]
        .description,
      "Drywall and finishing material"
    );

    assert.equal(
      context.reviewedEstimate
        .reviewedScope
        .labor[0]
        .description,
      "Repair wall and relocate outlet"
    );

    assert.equal(
      context.reviewedEstimate
        .reviewedScope
        .customerQuoteDraft
        .customerWording,
      "Repair the closet wall, relocate the outlet to the living room wall, and install a new outlet plate."
    );

    /*
     * Reviewed Estimate lineage remains explicit.
     */
    assert.equal(
      context.reviewedEstimate
        .reviewedScope
        .materials[0]
        .provenance,
      "AI_SUGGESTED"
    );

    assert.equal(
      context.reviewedEstimate
        .reviewedScope
        .materials[0]
        .sourceReferences[0]
        .type,
      "ESTIMATE_REVIEW"
    );

    /*
     * Most important R1-06 commercial boundary:
     * Estimate cost/reference/advisory numbers do not
     * become Quote pricing inputs.
     */
    assert.deepEqual(
      context.professionalInput
        .pricingInputs,
      []
    );

    assert.equal(
      Object.hasOwn(
        context.reviewedEstimate,
        "internalCost"
      ),
      false
    );

    assert.equal(
      Object.hasOwn(
        context.reviewedEstimate,
        "suggestedSellingRange"
      ),
      false
    );

    assert.equal(
      Object.hasOwn(
        context.reviewedEstimate,
        "professionalSellingPriceMinor"
      ),
      false
    );

    const serializedReviewed =
      JSON.stringify(
        context.reviewedEstimate
      );

    assert.doesNotMatch(
      serializedReviewed,
      /retailerReference/
    );

    assert.doesNotMatch(
      serializedReviewed,
      /effectiveUnitCostMinor/
    );

    assert.doesNotMatch(
      serializedReviewed,
      /estimatedCostMinor/
    );

    assert.doesNotMatch(
      serializedReviewed,
      /professionalOverride/
    );

    assert.doesNotMatch(
      serializedReviewed,
      /private_retailer_reference/
    );

    assert.doesNotMatch(
      serializedReviewed,
      /private_labor_cost/
    );

    assert.equal(
      context.reviewedEstimate
        .canonicalMutationPerformed,
      false
    );
  }
);
