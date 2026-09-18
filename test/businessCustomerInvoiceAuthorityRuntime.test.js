"use strict";

const assert =
  require("node:assert/strict");

const {
  readFileSync,
} = require("node:fs");

const test =
  require("node:test");


const invoice =
  readFileSync(
    "server/finance/invoicePaymentService.js",
    "utf8"
  );

const shared =
  readFileSync(
    "server/relationships/businessJobAuthority.js",
    "utf8"
  );


function region(
  start,
  end
) {
  const a =
    invoice.indexOf(start);

  const b =
    invoice.indexOf(
      end,
      a
    );

  assert.notEqual(
    a,
    -1,
    `missing ${start}`
  );

  assert.notEqual(
    b,
    -1,
    `missing ${end}`
  );

  return invoice.slice(
    a,
    b
  );
}


test(
  "business_customer Invoice context uses local exact durable authority",
  () => {
    const body =
      region(
        "const BUSINESS_CUSTOMER_INVOICE_CONTEXT_SQL",
        "async function loadProfessionalJobContext"
      );

    assert.match(
      body,
      /jobs\.source_type[\s\S]*'business_customer'/
    );

    assert.match(
      body,
      /business_customer_job_sources/
    );

    assert.match(
      body,
      /job_customer_parties/
    );

    assert.match(
      body,
      /professional\.source_evidence_type[\s\S]*'business_customer'/
    );

    assert.match(
      body,
      /roles\.role[\s\S]*'CUSTOMER'/
    );

    assert.match(
      body,
      /roles\.role[\s\S]*'PRIMARY_PROFESSIONAL'/
    );

    assert.match(
      body,
      /jobs\.job_request_id IS NULL/
    );

    assert.match(
      body,
      /jobs\.source_request_selection_id IS NULL/
    );

    assert.match(
      body,
      /jobs\.source_request_relationship_id IS NULL/
    );

    assert.match(
      body,
      /jobs\.originating_business_document_id IS NULL/
    );
  }
);


test(
  "Invoice Job resolver preserves request path and Quick Quote before local business_customer",
  () => {
    const body =
      region(
        "async function loadProfessionalJobContext",
        "function professionalAuthorized"
      );

    assert.match(
      body,
      /loadBusinessJobContext/
    );

    assert.match(
      body,
      /loadBusinessCustomerInvoiceContext/
    );

    assert.ok(
      body.indexOf(
        "loadBusinessJobContext"
      ) <
      body.indexOf(
        "loadBusinessCustomerInvoiceContext"
      )
    );
  }
);


test(
  "shared Quick Quote authority remains strict and untouched",
  () => {
    assert.match(
      shared,
      /WHERE jobs\.source_type='business_document'/
    );

    assert.match(
      shared,
      /business_document_working_drafts/
    );

    assert.doesNotMatch(
      shared,
      /business_customer_job_sources/
    );
  }
);


test(
  "Invoice billing accepts both Meetro and both business-owned origins",
  () => {
    const body =
      region(
        "async function loadEffectiveApprovedBillingLines",
        "function effectiveApprovedPaymentTerms"
      );

    assert.match(
      body,
      /'ordinary_request_selection'[\s\S]*'existing_customer_request'/
    );

    assert.match(
      body,
      /'MEETRO_CUSTOMER'/
    );

    assert.match(
      body,
      /'business_document'[\s\S]*'business_customer'/
    );

    assert.match(
      body,
      /'EXTERNAL_EVIDENCE'/
    );

    assert.match(
      body,
      /customer_parties\.business_contact_id[\s\S]*source_job\.business_contact_id/
    );

    assert.match(
      body,
      /customer_parties\.business_customer_relationship_id[\s\S]*source_job\.business_customer_relationship_id/
    );
  }
);


test(
  "Invoice context reload supports Quick Quote and full business_customer separately",
  () => {
    const body =
      region(
        "async function loadInvoiceContext",
        "async function loadCustomerInvoiceContext"
      );

    assert.match(
      body,
      /loadBusinessJobContext/
    );

    assert.match(
      body,
      /loadBusinessCustomerInvoiceContext/
    );
  }
);


test(
  "external Invoice issuance and draft action support both business-owned origins",
  () => {
    const projection =
      region(
        "function invoiceProjection",
        "async function loadInvoiceProjection"
      );

    const issue =
      region(
        "async function issueInvoice",
        "async function recordPayment"
      );

    assert.match(
      projection,
      /"business_document"[\s\S]*"business_customer"/
    );

    assert.match(
      issue,
      /"business_document"[\s\S]*"business_customer"/
    );

    assert.match(
      invoice,
      /invoiceAuthorityFields/
    );
  }
);


test(
  "professional Invoice workspace loads both business-owned origins",
  () => {
    const body =
      region(
        "async function getProfessionalInvoiceWorkspace",
        "module.exports ="
      );

    assert.match(
      body,
      /BUSINESS_JOB_CONTEXT_SQL/
    );

    assert.match(
      body,
      /BUSINESS_CUSTOMER_INVOICE_CONTEXT_SQL/
    );
  }
);
