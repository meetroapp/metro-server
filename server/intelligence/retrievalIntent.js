"use strict";

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const normalize = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
const documentNumber = (value) => String(value || "").toUpperCase().replace(/[\s-]/g, "");

// Only clause heads nominate operations. Embedded "what"/"how" are not intent.
function parseRetrievalIntent(message) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase().replace(/’/g, "'");
  const clauses = lower.split(/[;!?\n]|\.(?!\d)|\b(?:and|then|but|also)\b/).map((s) => s.trim()).filter(Boolean);
  const operational = clauses.some((s) => /^(?:(?:please|can you|could you)\s+)?(?:move|schedule|reschedule|update|record|create|prepare|revise|edit|mark|complete|cancel|approve|pay|send|issue|delete|add)\b/.test(s));
  const mixed = operational && clauses.some((s) => /^(?:explain|why|how|what|summarize|compare|help|tell me)\b/.test(s));
  const reasoning = /\b(?:explain|why|summari[sz]e|compare|should|prepare for|bring|missing|help|troubleshoot)\b/.test(lower);
  const number = text.match(/\b(?:INV\s*-?\s*[0-9A-F]{12}|(?:Q|I)\s*-?\s*\d{1,12})\b/i)?.[0] || "";
  const id = text.match(UUID)?.[0]?.toLowerCase() || text.match(/\b(?:job request|conversation)\s+(?:number\s+|#)?([1-9]\d{0,14})\b/i)?.[1] || "";

  // Creating an Invoice FROM an explicitly identified Quote is an Invoice
  // operation whose retrieval authority must first resolve the source Quote.
  // Keep source-record type separate from requested operation kind.
  const quoteToInvoiceSource =
    operational &&
    /^(?:(?:please|can you|could you)\s+)?(?:create|prepare|build|draft|make|start)\s+(?:(?:a|an)\s+)?(?:new\s+)?invoice\b/.test(lower) &&
    (/\bquotes?\b/.test(lower) || /^Q/i.test(number));

  let type = /\binvoices?\b/.test(lower) || /^I/i.test(number) ? "INVOICE"
    : /\bquotes?\b/.test(lower) || /^Q/i.test(number) ? "QUOTE"
      : /\b(?:job|service) requests?\b/.test(lower) ? "JOB_REQUEST"
        : /\b(?:customer relationships?|relationship)\b/.test(lower) ? "CUSTOMER_RELATIONSHIP"
          : /\bevaluations?\b/.test(lower) ? "EVALUATION"
            : /\bconversations?\b/.test(lower) ? "CONVERSATION" : "JOB";
  const kind = /\bdeposit/.test(lower) ? "DEPOSIT"
    : /\b(?:invoice|invoices|paid|unpaid|owe|owes|money|balance)\b/.test(lower) || /^I/i.test(number) ? "INVOICE"
      : /\b(?:quote|quotes|approved|approval)\b/.test(lower) || /^Q/i.test(number) ? "QUOTE"
        : /\b(?:when|time|scheduled?|tomorrow|today|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next job)\b/.test(lower) ? "SCHEDULE"
          : /\b(?:status|progress|completed?|happening|active)\b/.test(lower) ? "STATUS" : "REASONING";
  if (kind === "INVOICE") {
    type = quoteToInvoiceSource ? "QUOTE" : "INVOICE";
  }
  const deictic = /\b(?:here|that|it|current|this(?! (?:morning|afternoon|evening)))\b/.test(lower);
  // These grammatical slots are bounded entity references, not free-text SQL.
  let name = lower.match(/\b(?:is|was|for|about|with|of)\s+(.{1,100}?)'s\s+(?:job|quote|invoice|deposit|evaluation|visit|request|conversation)/)?.[1]
    || lower.match(/^(?:(?:please|can you|could you)\s+)?(?:move|schedule|reschedule|update|record|explain|summarize|revise|complete|cancel)\s+(.{1,100}?)'s\s+(?:job|quote|invoice|deposit|evaluation|visit|request|conversation)/)?.[1]
    || lower.match(/\b(?:is|with|about|for|of)\s+(?:the\s+)?(.{1,100}?)\s+(?:job|quote|invoice|evaluation|relationship|conversation)\b/)?.[1]
    || lower.match(/\bwhat about\s+(.{1,100}?)[?.!]*$/)?.[1] || "";
  name = name.replace(/^(?:the\s+)?status of\s+(?:the\s+)?/, "").replace(/^(?:what time is|when is|has|is|move|schedule|reschedule|update|record|explain|summarize|the)\s+/g, "").trim();
  if (/^(?:this|that|my|the|a|an|anything|scheduled|happening|current|next)$/.test(name)) name = "";
  const depositName = lower.match(/\bhas\s+(.{1,100}?)\s+paid\s+(?:the\s+)?deposit/);
  if (depositName) name = depositName[1];
  const aggregate = !name && !id && !number && !deictic && /\b(?:which|what jobs|what quotes?|what invoices|what is scheduled|what's scheduled|what do i have|do i have|next job|today|tomorrow|this morning|this afternoon|this evening|in progress|outstanding|unpaid)\b/.test(lower);
  const requiresRecord = Boolean(name || id || number || deictic && /\b(?:job|quote|invoice|request|evaluation|visit|customer|relationship|conversation|status|happening|summarize|explain)\b/.test(lower) || aggregate || operational);
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].findIndex((day) => lower.includes(day));
  return { type, kind, name: normalize(name), id, number: documentNumber(number), deictic, aggregate, operational, mixed, reasoning,
    requiresRecord, next: /\bnext job\b/.test(lower), day: /\btomorrow\b/.test(lower) ? "tomorrow" : /\btoday\b|this (?:morning|afternoon|evening)/.test(lower) ? "today" : weekday >= 0 ? weekday : null,
    daypart: lower.match(/\b(morning|afternoon|evening)\b/)?.[1] || null,
    outstanding: /\b(?:unpaid|owe|owes|outstanding|waiting|remains)\b/.test(lower), inProgress: /\b(?:in progress|active)\b/.test(lower) };
}

function matchRank(candidate, query) {
  if (query.id) return candidate.record.id === query.id ? 3 : 0;
  if (query.number) return documentNumber(candidate.number) === query.number ? 3 : 0;
  if (!query.name) return 1;
  const fields = [candidate.name, candidate.title].map(normalize).filter(Boolean);
  if (fields.includes(query.name)) return 3;
  return fields.some((s) => (` ${s} `).includes(` ${query.name} `)) ? 1 : 0;
}

module.exports = { parseRetrievalIntent, matchRank, normalize, documentNumber };
