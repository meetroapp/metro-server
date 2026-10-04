"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const {
  acceptTeamInvitation,
  deactivateTeamMember,
  inviteTeamMember,
  listTeam,
  updateTeamMemberRole,
} = require("../server/team/teamService");
const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");

async function createUser(pool, suffix, accountType = "homeowner") {
  const result = await pool.query(
    `INSERT INTO users
       (username, email, password_hash, role, account_type, business_name, business_category)
     VALUES ($1, $2, 'test-only', $3, $4, '', '') RETURNING id, email`,
    [`team-${suffix}`, `team-${suffix}@example.test`, accountType === "professional" ? "contractor" : "homeowner", accountType]
  );
  return result.rows[0];
}

test("PostgreSQL certifies exact-business invitations, seat reservation, identity acceptance, roles, and historical deactivation", { skip: !process.env.DATABASE_URL }, async () => {
  assertSafeTestDatabaseUrl(process.env.DATABASE_URL, { nodeEnv: process.env.NODE_ENV });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const suffix = randomUUID();
  try {
    const owner = await createUser(pool, `${suffix}-owner`, "professional");
    const employee = await createUser(pool, `${suffix}-employee`);
    const wrongEmployee = await createUser(pool, `${suffix}-wrong`);
    const secondEmployee = await createUser(pool, `${suffix}-second`);
    const profile = await pool.query(
      `INSERT INTO contractor_profiles (user_id, business_name, category)
       VALUES ($1, $2, 'testing') RETURNING id`,
      [owner.id, `Team ${suffix}`]
    );
    const businessId = Number(profile.rows[0].id);
    await pool.query(
      `INSERT INTO business_team_memberships
         (contractor_profile_id, user_id, role, status, activated_at, created_by_user_id)
       VALUES ($1, $2, 'OWNER', 'ACTIVE', CURRENT_TIMESTAMP, $2)`,
      [businessId, owner.id]
    );
    await pool.query(
      `INSERT INTO meetro_business_trials
         (user_id, contractor_profile_id, created_reason, starts_at, ends_at)
       VALUES ($1, $2, 'BUSINESS_ACTIVATION', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '14 days')`,
      [owner.id, businessId]
    );

    const invitation = await inviteTeamMember({
      pool,
      authenticatedActor: owner,
      businessId,
      email: employee.email,
      displayName: "Field Employee",
      role: "FIELD_EMPLOYEE",
      environment: { NODE_ENV: "production" },
    });
    assert.equal(invitation.code, "BUSINESS_TEAM_INVITATION_CREATED");
    assert.equal(invitation.seatAuthority.seatLimit, 2);
    assert.equal(invitation.seatAuthority.reservedSeats, 2);

    const blockedByReservedSeat = await inviteTeamMember({
      pool,
      authenticatedActor: owner,
      businessId,
      email: secondEmployee.email,
      displayName: "Second Employee",
      role: "MANAGER",
      environment: { NODE_ENV: "production" },
    });
    assert.equal(blockedByReservedSeat.code, "TEAM_SEAT_LIMIT_REACHED");

    const wrongIdentity = await acceptTeamInvitation({
      pool,
      authenticatedActor: wrongEmployee,
      token: invitation.invitation.token,
    });
    assert.equal(wrongIdentity.code, "TEAM_INVITATION_IDENTITY_MISMATCH");

    const accepted = await acceptTeamInvitation({
      pool,
      authenticatedActor: employee,
      token: invitation.invitation.token,
    });
    assert.equal(accepted.code, "BUSINESS_TEAM_INVITATION_ACCEPTED");
    assert.equal(accepted.membership.userId, Number(employee.id));
    assert.equal(accepted.membership.businessId, businessId);
    assert.equal(accepted.membership.role, "FIELD_EMPLOYEE");

    const replay = await acceptTeamInvitation({
      pool,
      authenticatedActor: employee,
      token: invitation.invitation.token,
    });
    assert.equal(replay.code, "BUSINESS_TEAM_INVITATION_ALREADY_ACCEPTED");
    assert.equal(replay.membership.id, accepted.membership.id);

    const promoted = await updateTeamMemberRole({
      pool,
      authenticatedActor: owner,
      businessId,
      membershipId: accepted.membership.id,
      role: "MANAGER",
    });
    assert.equal(promoted.membership.role, "MANAGER");

    const deactivated = await deactivateTeamMember({
      pool,
      authenticatedActor: owner,
      businessId,
      membershipId: accepted.membership.id,
    });
    assert.equal(deactivated.membership.status, "DEACTIVATED");

    const afterDeactivation = await listTeam({
      pool,
      authenticatedActor: owner,
      businessId,
      environment: { NODE_ENV: "production" },
    });
    assert.equal(afterDeactivation.members.some((member) => member.id === accepted.membership.id && member.status === "DEACTIVATED"), true);
    assert.equal(afterDeactivation.seatAuthority.reservedSeats, 1);

    const releasedSeat = await inviteTeamMember({
      pool,
      authenticatedActor: owner,
      businessId,
      email: secondEmployee.email,
      displayName: "Second Employee",
      role: "BOOKKEEPER_FINANCE",
      environment: { NODE_ENV: "production" },
    });
    assert.equal(releasedSeat.code, "BUSINESS_TEAM_INVITATION_CREATED");
    assert.equal(releasedSeat.seatAuthority.reservedSeats, 2);

    const ownerDeactivation = await deactivateTeamMember({
      pool,
      authenticatedActor: owner,
      businessId,
      membershipId: afterDeactivation.members.find((member) => member.role === "OWNER").id,
    });
    assert.equal(ownerDeactivation.code, "TEAM_OWNER_OR_SELF_DEACTIVATION_FORBIDDEN");

    const history = await pool.query(
      `SELECT status, deactivated_at FROM business_team_memberships WHERE id = $1`,
      [accepted.membership.id]
    );
    assert.equal(history.rows[0].status, "DEACTIVATED");
    assert.ok(history.rows[0].deactivated_at);
  } finally {
    await pool.end();
  }
});
