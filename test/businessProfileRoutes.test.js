"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-business-profile-routes";

const { app, createToken } = require("../index");

const normalizeSql = (sql) => String(sql).replace(/\s+/g, " ").trim();

function createPool() {
  const users = new Map([
    [1, { id: 1, email: "owner@example.test", role: "professional", token_version: 0 }],
    [2, { id: 2, email: "other@example.test", role: "professional", token_version: 0 }],
  ]);
  const profiles = new Map([
    [10, {
      id: 10,
      user_id: 1,
      business_name: "Original Business",
      category: "Home Services",
      phone: "",
      location: "Orlando",
      bio: "",
      image_url: "",
      profile_details: {},
      created_at: "2026-07-14T12:00:00.000Z",
    }],
  ]);

  return {
    users,
    profiles,
    async query(text, values = []) {
      const sql = normalizeSql(text);
      if (sql.includes("SELECT id, email, role, token_version FROM users WHERE id = $1")) {
        const user = users.get(Number(values[0]));
        return { rows: user ? [user] : [] };
      }
      if (sql.includes("UPDATE contractor_profiles SET")) {
        const profile = profiles.get(Number(values[6]));
        if (!profile || profile.user_id !== Number(values[7])) return { rows: [] };
        Object.assign(profile, {
          business_name: values[0],
          category: values[1],
          phone: values[2],
          location: values[3],
          bio: values[4],
          profile_details: JSON.parse(values[5]),
        });
        return { rows: [{ ...profile }] };
      }
      if (sql.includes("FROM contractor_profiles WHERE user_id = $1")) {
        const profile = [...profiles.values()].find((item) => item.user_id === Number(values[0]));
        return { rows: profile ? [{ ...profile }] : [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function getHandlers(method, path) {
  const layer = app.router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((item) => item.handle);
}

function response() {
  return {
    statusCode: 200,
    body: null,
    finished: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.finished = true; return this; },
  };
}

async function invoke(method, path, { pool, user, body = {}, params = {} } = {}) {
  app.locals.pool = pool;
  const req = {
    app,
    body,
    params,
    headers: user ? { authorization: `Bearer ${createToken(user)}` } : {},
  };
  const res = response();
  try {
    for (const handler of getHandlers(method, path)) {
      if (res.finished) break;
      if (handler.length < 3) {
        await handler(req, res);
      } else {
        await new Promise((resolve, reject) => {
          const next = (error) => error ? reject(error) : resolve();
          Promise.resolve(handler(req, res, next)).then(() => {
            if (res.finished) resolve();
          }, reject);
        });
      }
    }
    return res;
  } finally {
    delete app.locals.pool;
  }
}

const payload = {
  business_name: "Canonical Business",
  category: "Home Services",
  phone: "555-0100",
  location: "Greater Orlando",
  bio: "Trusted repairs",
  image_url: "",
  street_address: "100 Main Street",
  address_line_2: "",
  city: "Orlando",
  state_province: "FL",
  postal_code: "32801",
  country: "US",
  service_area: "Greater Orlando",
  show_business_address_public: false,
  business_hours: "Monday-Friday 8-5",
  license_number: "LIC-100",
  license_state: "FL",
  license_type: "Contractor",
  license_expiration: "2027-12-31",
  service_specialties: ["door_repair_replacement"],
  available_now: true,
  dispatch_ready: false,
};

test("business profile update requires authentication and enforces ownership", async () => {
  const pool = createPool();
  const unauthenticated = await invoke("put", "/contractor-profiles/:id", {
    pool,
    body: payload,
    params: { id: "10" },
  });
  const crossOwner = await invoke("put", "/contractor-profiles/:id", {
    pool,
    user: pool.users.get(2),
    body: payload,
    params: { id: "10" },
  });

  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(crossOwner.statusCode, 404);
  assert.equal(pool.profiles.get(10).business_name, "Original Business");
});

test("confirmed update persists and restores canonical fields in another authenticated session", async () => {
  const pool = createPool();
  const owner = pool.users.get(1);
  const updated = await invoke("put", "/contractor-profiles/:id", {
    pool,
    user: owner,
    body: payload,
    params: { id: "10" },
  });
  const reloaded = await invoke("get", "/my-contractor-profile", {
    pool,
    user: { ...owner },
  });

  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.code, "BUSINESS_PROFILE_UPDATED");
  assert.equal(updated.body.profile.business_hours, "Monday-Friday 8-5");
  assert.equal(reloaded.body.profile.business_name, "Canonical Business");
  assert.deepEqual(reloaded.body.profile.service_specialties, ["door_repair_replacement"]);
  assert.equal(reloaded.body.profile.street_address, "100 Main Street");
});

test("malformed update fails without changing the authoritative profile", async () => {
  const pool = createPool();
  const result = await invoke("put", "/contractor-profiles/:id", {
    pool,
    user: pool.users.get(1),
    body: { ...payload, available_now: "yes" },
    params: { id: "10" },
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.code, "INVALID_BUSINESS_PROFILE_FIELD");
  assert.equal(pool.profiles.get(10).business_name, "Original Business");
});
