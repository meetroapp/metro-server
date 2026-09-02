"use strict";

// Certified lifecycle sequence; migration 78 revised after its staging rollback.
// Migrations 76–77 and 79–81, and the production convergence manifest, remain unchanged.
module.exports = [
  {
    "filename": "202609020001_add_business_origin_commercial_job_foundation.sql",
    "checksum": "332eb2ef7f08340931e1d583b3056ae727a724ed15851bba76076258444ed41d"
  },
  {
    "filename": "202609020002_create_quote_external_approval_authority.sql",
    "checksum": "dc371b7540461320eff30a686c86ec889e7de07fcfd62528b6182ba2d7abb776"
  },
  {
    "filename": "202609020003_generalize_pre_work_deposit_approval_authority.sql",
    "checksum": "8c7a089876eaad046c2db00fd50d64eb13393e474f4a1b29737228426e9bda93"
  },
  {
    "filename": "202609020004_generalize_approved_work_visit_approval_authority.sql",
    "checksum": "448481c6a55de4fbc750201db6b54e3a42812e399209dfbdbcd1cc9598ee5fde"
  },
  {
    "filename": "202609020005_create_external_visit_schedule_confirmation.sql",
    "checksum": "7cb1b75536b425dbb9cdfa0aef96b5a1aaa11950b67d0cacc625185e4c8e0d0a"
  },
  {
    "filename": "202609020006_generalize_work_preparation_execution_approval.sql",
    "checksum": "4dda2aac1af54904293128be0dd95b5957304f30a31b9d5678776787cccfa853"
  }
];
