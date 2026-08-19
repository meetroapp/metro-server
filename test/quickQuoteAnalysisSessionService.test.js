"use strict";

const assert =
  require("node:assert/strict");
const test =
  require("node:test");

const {
  createQuickQuoteAnalysisSessionService,
} = require(
  "../server/intelligence/quickQuoteAnalysisSessionService"
);

const ACTOR = {
  id: 73,
  role: "professional",
};

const OTHER_ACTOR = {
  id: 91,
  role: "professional",
};

const KEYS = Object.freeze({
  create:
    "40000000-0000-4000-8000-000000000001",
  evidenceSame:
    "40000000-0000-4000-8000-000000000002",
  evidenceChanged:
    "40000000-0000-4000-8000-000000000003",
  evidenceReverted:
    "40000000-0000-4000-8000-000000000004",
  turn1:
    "40000000-0000-4000-8000-000000000005",
  turn2:
    "40000000-0000-4000-8000-000000000006",
  discard:
    "40000000-0000-4000-8000-000000000007",
});

function now() {
  return "2026-08-19T13:30:00.000Z";
}

function fakePersistence() {
  const state = {
    commands: new Map(),
    sessions: new Map(),
    evidence: new Map(),
    turns: new Map(),
  };

  const commandKey = ({
    actorUserId,
    authorityScope,
    commandName,
    commandScope,
    idempotencyKey,
  }) => [
    actorUserId,
    authorityScope,
    commandName,
    commandScope,
    idempotencyKey,
  ].join("|");

  const evidenceKey =
    (sessionId, version) =>
      `${sessionId}:${version}`;

  return {
    state,

    async withTransaction(
      _pool,
      work
    ) {
      return work({});
    },

    async withReadTransaction(
      _pool,
      work
    ) {
      return work({});
    },

    async findCommand(
      _client,
      input
    ) {
      return (
        state.commands.get(
          commandKey(input)
        ) || null
      );
    },

    async reserveCommand(
      _client,
      input
    ) {
      const key =
        commandKey(input);

      if (state.commands.has(key)) {
        return {
          created: false,
          record:
            state.commands.get(key),
        };
      }

      const row = {
        id: input.commandId,
        actor_user_id:
          input.actorUserId,
        authority_scope:
          input.authorityScope,
        command_name:
          input.commandName,
        command_scope:
          input.commandScope,
        idempotency_key:
          input.idempotencyKey,
        request_fingerprint:
          input.requestFingerprint,
        result_reference: null,
        completed_at: null,
        created_at: now(),
      };

      state.commands.set(
        key,
        row
      );

      return {
        created: true,
        record: row,
      };
    },

    async completeCommand(
      _client,
      {
        commandId,
        resultReference,
      }
    ) {
      const row =
        [...state.commands.values()]
          .find(
            (item) =>
              item.id === commandId
          );

      assert.ok(row);

      row.result_reference =
        resultReference;

      row.completed_at = now();

      return row;
    },

    async createSessionRecord(
      _client,
      {
        sessionId,
        actorUserId,
        authorityScope,
        commandId,
      }
    ) {
      const row = {
        id: sessionId,
        actor_user_id:
          actorUserId,
        authority_scope:
          authorityScope,
        authority_classification:
          "PRIVATE_NON_CANONICAL",
        created_command_idempotency_id:
          commandId,
        created_at: now(),
      };

      state.sessions.set(
        sessionId,
        row
      );

      return row;
    },

    async loadOwnedSession(
      _client,
      {
        sessionId,
        actorUserId,
      }
    ) {
      const row =
        state.sessions.get(
          sessionId
        );

      return (
        row &&
        Number(row.actor_user_id) ===
          Number(actorUserId)
      )
        ? row
        : null;
    },

    async appendEvidenceRecord(
      _client,
      input
    ) {
      const row = {
        session_id:
          input.sessionId,
        version:
          input.version,
        actor_user_id:
          input.actorUserId,
        professional_input:
          input.professionalInput,
        photo_references:
          input.photoReferences,
        evidence_fingerprint:
          input.evidenceFingerprint,
        command_idempotency_id:
          input.commandId,
        created_at: now(),
      };

      state.evidence.set(
        evidenceKey(
          input.sessionId,
          input.version
        ),
        row
      );

      return row;
    },

    async loadLatestEvidence(
      _client,
      {
        sessionId,
        actorUserId,
      }
    ) {
      const rows =
        [...state.evidence.values()]
          .filter(
            (row) =>
              row.session_id ===
                sessionId &&
              Number(
                row.actor_user_id
              ) ===
                Number(actorUserId)
          )
          .sort(
            (a, b) =>
              Number(b.version) -
              Number(a.version)
          );

      return rows[0] || null;
    },

    async loadEvidenceVersion(
      _client,
      {
        sessionId,
        actorUserId,
        version,
      }
    ) {
      const row =
        state.evidence.get(
          evidenceKey(
            sessionId,
            version
          )
        );

      return (
        row &&
        Number(row.actor_user_id) ===
          Number(actorUserId)
      )
        ? row
        : null;
    },

    async listEvidence(
      _client,
      {
        sessionId,
        actorUserId,
      }
    ) {
      return [
        ...state.evidence.values(),
      ]
        .filter(
          (row) =>
            row.session_id ===
              sessionId &&
            Number(
              row.actor_user_id
            ) ===
              Number(actorUserId)
        )
        .sort(
          (a, b) =>
            Number(a.version) -
            Number(b.version)
        );
    },

    async nextEvidenceVersion(
      _client,
      {
        sessionId,
        actorUserId,
      }
    ) {
      const rows =
        await this.listEvidence(
          null,
          {
            sessionId,
            actorUserId,
          }
        );

      return rows.length
        ? Number(
            rows[
              rows.length - 1
            ].version
          ) + 1
        : 1;
    },

    async appendTurnRecord(
      _client,
      input
    ) {
      const row = {
        id: input.turnId,
        session_id:
          input.sessionId,
        turn_index:
          input.turnIndex,
        actor_user_id:
          input.actorUserId,
        evidence_version:
          input.evidenceVersion,
        role: input.role,
        authority_classification:
          "PRIVATE_NON_CANONICAL",
        turn_payload:
          input.turnPayload,
        command_idempotency_id:
          input.commandId,
        created_at: now(),
      };

      state.turns.set(
        input.turnId,
        row
      );

      return row;
    },

    async loadTurn(
      _client,
      {
        turnId,
        sessionId,
        actorUserId,
      }
    ) {
      const row =
        state.turns.get(turnId);

      return (
        row &&
        row.session_id ===
          sessionId &&
        Number(
          row.actor_user_id
        ) === Number(actorUserId)
      )
        ? row
        : null;
    },

    async listTurns(
      _client,
      {
        sessionId,
        actorUserId,
      }
    ) {
      return [
        ...state.turns.values(),
      ]
        .filter(
          (row) =>
            row.session_id ===
              sessionId &&
            Number(
              row.actor_user_id
            ) ===
              Number(actorUserId)
        )
        .sort(
          (a, b) =>
            Number(a.turn_index) -
            Number(b.turn_index)
        );
    },

    async nextTurnIndex(
      _client,
      {
        sessionId,
        actorUserId,
      }
    ) {
      const rows =
        await this.listTurns(
          null,
          {
            sessionId,
            actorUserId,
          }
        );

      return rows.length
        ? Number(
            rows[
              rows.length - 1
            ].turn_index
          ) + 1
        : 1;
    },

    async deleteOwnedSession(
      _client,
      {
        sessionId,
        actorUserId,
      }
    ) {
      const row =
        state.sessions.get(
          sessionId
        );

      if (
        !row ||
        Number(row.actor_user_id) !==
          Number(actorUserId)
      ) {
        return null;
      }

      state.sessions.delete(
        sessionId
      );

      for (
        const [key, evidence]
        of state.evidence
      ) {
        if (
          evidence.session_id ===
          sessionId
        ) {
          state.evidence.delete(key);
        }
      }

      for (
        const [key, turn]
        of state.turns
      ) {
        if (
          turn.session_id ===
          sessionId
        ) {
          state.turns.delete(key);
        }
      }

      return {
        id: sessionId,
      };
    },
  };
}

function serviceFixture() {
  const persistence =
    fakePersistence();

  let sequence = 0;

  const service =
    createQuickQuoteAnalysisSessionService({
      persistence,
      randomId() {
        sequence += 1;

        const suffix =
          String(sequence)
            .padStart(12, "0");

        return (
          "10000000-0000-4000-8000-" +
          suffix
        );
      },
      async resolveProfessionalProfileId(
        _client,
        actorUserId
      ) {
        return Number(
          actorUserId
        ) === ACTOR.id
          ? 500
          : null;
      },
      normalizePhotoCollection(
        photos
      ) {
        return photos.map(
          (photo, index) => ({
            public_id:
              photo.public_id,
            secure_url:
              photo.secure_url,
            version:
              photo.version || 1,
            format:
              photo.format || "jpg",
            width:
              photo.width || 1200,
            height:
              photo.height || 900,
            display_order: index,
          })
        );
      },
      env: {},
    });

  return {
    persistence,
    service,
  };
}

const pool = {
  async connect() {
    throw new Error(
      "Fake persistence must own transactions."
    );
  },
};

test(
  "create owns a private non-canonical session and replays the same idempotent command",
  async () => {
    const {
      persistence,
      service,
    } = serviceFixture();

    const input = {
      pool,
      authenticatedActor: ACTOR,
      idempotencyKey:
        KEYS.create,
      professionalInput:
        "Bathroom vanity has water damage.",
      photos: [],
    };

    const first =
      await service.createSession(
        input
      );

    const replay =
      await service.createSession(
        input
      );

    assert.equal(
      first.status,
      201
    );

    assert.equal(
      first.code,
      "QUICK_QUOTE_ANALYSIS_SESSION_CREATED"
    );

    assert.equal(
      first.session
        .authorityClassification,
      "PRIVATE_NON_CANONICAL"
    );

    assert.equal(
      first.session
        .latestEvidenceVersion,
      1
    );

    assert.equal(
      replay.status,
      200
    );

    assert.equal(
      replay.code,
      "QUICK_QUOTE_ANALYSIS_SESSION_REPLAYED"
    );

    assert.equal(
      replay.session.sessionId,
      first.session.sessionId
    );

    assert.equal(
      persistence.state
        .sessions.size,
      1
    );

    assert.equal(
      first.canonicalMutationPerformed,
      false
    );
  }
);

test(
  "same current evidence does not create a new version but a later reversion remains chronological",
  async () => {
    const {
      persistence,
      service,
    } = serviceFixture();

    const created =
      await service.createSession({
        pool,
        authenticatedActor: ACTOR,
        idempotencyKey:
          KEYS.create,
        professionalInput:
          "Original evidence",
        photos: [],
      });

    const sessionId =
      created.session.sessionId;

    const unchanged =
      await service.appendEvidence({
        pool,
        authenticatedActor: ACTOR,
        sessionId,
        idempotencyKey:
          KEYS.evidenceSame,
        professionalInput:
          "Original evidence",
        photos: [],
      });

    assert.equal(
      unchanged.code,
      "QUICK_QUOTE_ANALYSIS_EVIDENCE_CURRENT"
    );

    assert.equal(
      unchanged.changed,
      false
    );

    assert.equal(
      unchanged.evidence.version,
      1
    );

    const changed =
      await service.appendEvidence({
        pool,
        authenticatedActor: ACTOR,
        sessionId,
        idempotencyKey:
          KEYS.evidenceChanged,
        professionalInput:
          "Changed evidence",
        photos: [],
      });

    assert.equal(
      changed.evidence.version,
      2
    );

    const reverted =
      await service.appendEvidence({
        pool,
        authenticatedActor: ACTOR,
        sessionId,
        idempotencyKey:
          KEYS.evidenceReverted,
        professionalInput:
          "Original evidence",
        photos: [],
      });

    assert.equal(
      reverted.evidence.version,
      3
    );

    const rows =
      [...persistence.state
        .evidence.values()]
        .filter(
          (row) =>
            row.session_id ===
            sessionId
        )
        .sort(
          (a, b) =>
            a.version -
            b.version
        );

    assert.equal(
      rows.length,
      3
    );

    assert.equal(
      rows[0]
        .evidence_fingerprint,
      rows[2]
        .evidence_fingerprint
    );

    assert.notEqual(
      rows[0]
        .evidence_fingerprint,
      rows[1]
        .evidence_fingerprint
    );
  }
);

test(
  "turn authority is ordered, idempotent, and refuses stale evidence",
  async () => {
    const {
      service,
    } = serviceFixture();

    const created =
      await service.createSession({
        pool,
        authenticatedActor: ACTOR,
        idempotencyKey:
          KEYS.create,
        professionalInput:
          "Initial evidence",
        photos: [],
      });

    const sessionId =
      created.session.sessionId;

    const firstTurn =
      await service.appendTurn({
        pool,
        authenticatedActor: ACTOR,
        sessionId,
        evidenceVersion: 1,
        role: "PROFESSIONAL",
        turnPayload: {
          text:
            "What should I verify?",
        },
        idempotencyKey:
          KEYS.turn1,
      });

    assert.equal(
      firstTurn.status,
      201
    );

    assert.equal(
      firstTurn.turn.turnIndex,
      1
    );

    const replay =
      await service.appendTurn({
        pool,
        authenticatedActor: ACTOR,
        sessionId,
        evidenceVersion: 1,
        role: "PROFESSIONAL",
        turnPayload: {
          text:
            "What should I verify?",
        },
        idempotencyKey:
          KEYS.turn1,
      });

    assert.equal(
      replay.code,
      "QUICK_QUOTE_ANALYSIS_TURN_REPLAYED"
    );

    assert.equal(
      replay.turn.turnId,
      firstTurn.turn.turnId
    );

    await service.appendEvidence({
      pool,
      authenticatedActor: ACTOR,
      sessionId,
      idempotencyKey:
        KEYS.evidenceChanged,
      professionalInput:
        "Evidence changed",
      photos: [],
    });

    // Durable retry identity wins over later evidence advancement.
    // The original successful v1 turn must still replay exactly.
    const replayAfterEvidenceChange =
      await service.appendTurn({
        pool,
        authenticatedActor: ACTOR,
        sessionId,
        evidenceVersion: 1,
        role: "PROFESSIONAL",
        turnPayload: {
          text:
            "What should I verify?",
        },
        idempotencyKey:
          KEYS.turn1,
      });

    assert.equal(
      replayAfterEvidenceChange.status,
      200
    );

    assert.equal(
      replayAfterEvidenceChange.code,
      "QUICK_QUOTE_ANALYSIS_TURN_REPLAYED"
    );

    assert.equal(
      replayAfterEvidenceChange
        .turn.turnId,
      firstTurn.turn.turnId
    );

    // Reusing that same command identity for different input is still
    // a conflict, not a stale-evidence response.
    const conflictAfterEvidenceChange =
      await service.appendTurn({
        pool,
        authenticatedActor: ACTOR,
        sessionId,
        evidenceVersion: 1,
        role: "PROFESSIONAL",
        turnPayload: {
          text:
            "Changed retry payload",
        },
        idempotencyKey:
          KEYS.turn1,
      });

    assert.equal(
      conflictAfterEvidenceChange.status,
      409
    );

    assert.equal(
      conflictAfterEvidenceChange.code,
      "QUICK_QUOTE_ANALYSIS_COMMAND_CONFLICT"
    );

    const stale =
      await service.appendTurn({
        pool,
        authenticatedActor: ACTOR,
        sessionId,
        evidenceVersion: 1,
        role: "MEETRO",
        turnPayload: {
          summary:
            "Old evidence answer",
        },
        idempotencyKey:
          KEYS.turn2,
      });

    assert.equal(
      stale.status,
      409
    );

    assert.equal(
      stale.code,
      "QUICK_QUOTE_ANALYSIS_EVIDENCE_STALE"
    );

    const current =
      await service.appendTurn({
        pool,
        authenticatedActor: ACTOR,
        sessionId,
        evidenceVersion: 2,
        role: "MEETRO",
        turnPayload: {
          summary:
            "Current evidence answer",
        },
        idempotencyKey:
          KEYS.turn2,
      });

    assert.equal(
      current.status,
      201
    );

    assert.equal(
      current.turn.turnIndex,
      2
    );

    assert.equal(
      current.turn
        .evidenceVersion,
      2
    );
  }
);

test(
  "session reads are owner-scoped and do not require browser-local authority",
  async () => {
    const {
      service,
    } = serviceFixture();

    const created =
      await service.createSession({
        pool,
        authenticatedActor: ACTOR,
        idempotencyKey:
          KEYS.create,
        professionalInput:
          "Private evidence",
        photos: [],
      });

    const owner =
      await service.getSession({
        pool,
        authenticatedActor: ACTOR,
        sessionId:
          created.session.sessionId,
      });

    const other =
      await service.getSession({
        pool,
        authenticatedActor:
          OTHER_ACTOR,
        sessionId:
          created.session.sessionId,
      });

    assert.equal(
      owner.status,
      200
    );

    assert.equal(
      owner.session
        .evidenceVersions[0]
        .professionalInput,
      "Private evidence"
    );

    assert.equal(
      other.status,
      404
    );

    assert.equal(
      other.code,
      "QUICK_QUOTE_ANALYSIS_SESSION_UNAVAILABLE"
    );
  }
);

test(
  "discard removes private session history and is safely replayable from durable command identity",
  async () => {
    const {
      persistence,
      service,
    } = serviceFixture();

    const created =
      await service.createSession({
        pool,
        authenticatedActor: ACTOR,
        idempotencyKey:
          KEYS.create,
        professionalInput:
          "Private evidence",
        photos: [],
      });

    const sessionId =
      created.session.sessionId;

    await service.appendTurn({
      pool,
      authenticatedActor: ACTOR,
      sessionId,
      evidenceVersion: 1,
      role: "PROFESSIONAL",
      turnPayload: {
        text: "Private turn",
      },
      idempotencyKey:
        KEYS.turn1,
    });

    const discarded =
      await service.discardSession({
        pool,
        authenticatedActor: ACTOR,
        sessionId,
        idempotencyKey:
          KEYS.discard,
      });

    assert.equal(
      discarded.code,
      "QUICK_QUOTE_ANALYSIS_SESSION_DISCARDED"
    );

    assert.equal(
      persistence.state
        .sessions.size,
      0
    );

    assert.equal(
      persistence.state
        .evidence.size,
      0
    );

    assert.equal(
      persistence.state
        .turns.size,
      0
    );

    const replay =
      await service.discardSession({
        pool,
        authenticatedActor: ACTOR,
        sessionId,
        idempotencyKey:
          KEYS.discard,
      });

    assert.equal(
      replay.status,
      200
    );

    assert.equal(
      replay.code,
      "QUICK_QUOTE_ANALYSIS_SESSION_DISCARD_REPLAYED"
    );

    assert.equal(
      replay.discarded,
      true
    );
  }
);

test(
  "invalid or unauthorized evidence fails without creating session authority",
  async () => {
    const {
      persistence,
      service,
    } = serviceFixture();

    const empty =
      await service.createSession({
        pool,
        authenticatedActor: ACTOR,
        idempotencyKey:
          KEYS.create,
        professionalInput: "   ",
        photos: [],
      });

    assert.equal(
      empty.status,
      400
    );

    const unauthorized =
      await service.createSession({
        pool,
        authenticatedActor:
          OTHER_ACTOR,
        idempotencyKey:
          KEYS.create,
        professionalInput:
          "Private evidence",
        photos: [],
      });

    assert.equal(
      unauthorized.status,
      404
    );

    assert.equal(
      unauthorized.code,
      "QUICK_QUOTE_ANALYSIS_AUTHORITY_UNAVAILABLE"
    );

    assert.equal(
      persistence.state
        .sessions.size,
      0
    );
  }
);
