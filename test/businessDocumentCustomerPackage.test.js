"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildBusinessDocumentCustomerPackage,
  buildCustomerPackageEmail,
  customerPackageHash,
} = require("../server/documents/businessDocumentCustomerPackage");

function document() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    documentType: "QUOTE",
    reference: "WQ-FAN",
    version: 3,
    content: {
      customerName: "Jack Smith",
      customerEmail: "jack@example.test",
      projectTitle: "Fan replacement",
      recommendedSolution: "Replace the fan.",
      materialItems: [{ name: "Fan", total: "89.99" }],
      laborItems: [{ description: "Installation", total: "180" }],
      terms: "50% deposit required before scheduling.",
      agreement: {
        exclusions: ["Painting"],
        additionalWorkTerms: "Extra work requires additional authorization.",
        hiddenConditionsTerms: "Hidden conditions are outside the original price.",
        diagnosticTerms: "Diagnostic time remains billable.",
        acceptanceTerms: "Approval applies only to this scope and version.",
      },
    },
    workspace: { privateReminders: [{ text: "margin is private" }], instructions: [{ text: "private conversation" }] },
    photos: [
      { id: "public-before", name: "before.jpg", role: "BEFORE", visibility: "CUSTOMER_VISIBLE", media: { secure_url: "https://res.cloudinary.com/demo/before.jpg" } },
      { id: "private-after", name: "after.jpg", role: "AFTER", visibility: "PRIVATE_INTERNAL", media: { secure_url: "https://res.cloudinary.com/demo/after.jpg" } },
    ],
  };
}

test("customer package binds exact saved Quote agreement and excludes every private workspace field", () => {
  const customerPackage = buildBusinessDocumentCustomerPackage(document(), { business_name: "Handyman LLC" });
  assert.equal(customerPackage.document.version, 3);
  assert.equal(customerPackage.totalMinor, 26999);
  assert.deepEqual(customerPackage.agreement.exclusions, ["Painting"]);
  assert.equal(customerPackage.photos.length, 1);
  assert.equal(customerPackage.photos[0].mediaId, "public-before");
  assert.match(customerPackageHash(customerPackage), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(customerPackage), /margin is private|private conversation|private-after/);

  const email = buildCustomerPackageEmail(customerPackage, { customerMessage: "Please review." });
  assert.match(email.text, /QUOTE \+ SERVICE AGREEMENT/);
  assert.match(email.text, /Hidden \/ Unforeseen Conditions/);
  assert.match(email.html, /before\.jpg/);
  assert.equal(email.attachment.contentType, "application/pdf");
  assert.match(Buffer.from(email.attachment.content, "base64").toString("utf8", 0, 8), /^%PDF-1\.4/);
});
