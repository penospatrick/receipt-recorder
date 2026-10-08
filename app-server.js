require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const ExcelJS = require("exceljs");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const helmet = require("helmet");
let ReceiptDatabase;

const app = express();
// Vercel's API function imports this app; local development uses start().
const port = Number(process.env.PORT || 3000);
const bootstrapPassword = process.env.ACCOUNTING_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET;
const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
const sessionCookie = "receipt_session";
const bootstrapUsername = (process.env.ADMIN_USERNAME || "admin").trim();
const permissions = [
  { key: "receipts:create", label: "Create receipts" },
  { key: "receipts:read_own", label: "View own receipts" },
  { key: "receipts:read_all", label: "View all receipts" },
  { key: "receipts:edit_own", label: "Edit own receipts" },
  { key: "receipts:edit_all", label: "Edit all receipts" },
  { key: "receipts:delete_own", label: "Delete own receipts" },
  { key: "receipts:delete_all", label: "Delete all receipts" },
  { key: "receipts:export", label: "Export receipts to Excel" },
  { key: "users:manage", label: "Manage user accounts" },
  { key: "groups:manage", label: "Manage user groups and permissions" },
  { key: "fields:manage", label: "Manage custom receipt fields" }
];
const validPermissionKeys = new Set(permissions.map((permission) => permission.key));

let database;
let storageInitialization;
let startupError = null;

try {
  if (!bootstrapPassword) throw new Error("ACCOUNTING_PASSWORD must be set to the initial admin password.");
  if (!sessionSecret || sessionSecret.length < 32) throw new Error("SESSION_SECRET must be set to a value at least 32 characters long.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535.");
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(bootstrapUsername)) {
    throw new Error("ADMIN_USERNAME must be 3-40 characters: letters, numbers, dots, dashes, or underscores.");
  }
  ({ ReceiptDatabase } = require("./db"));
  database = new ReceiptDatabase();
} catch (error) {
  startupError = error;
  console.error("Receipt Recorder configuration failed:", error);
}
if (process.env.VERCEL) app.set("trust proxy", 1);

const defaultGroups = [
  {
    name: "System Admin",
    description: "Manage all users, groups, settings, and receipt records.",
    permissions: permissions.map((permission) => permission.key),
    isSystem: true
  },
  {
    name: "Field Officer",
    description: "Create receipts and view receipts entered by this user.",
    permissions: ["receipts:create", "receipts:read_own"],
    isSystem: true
  },
  {
    name: "Accounting",
    description: "View all receipts and export filtered reports to Excel.",
    permissions: ["receipts:read_all", "receipts:export"],
    isSystem: true
  }
];

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function findUserById(userId) {
  return database.prepare(`
    SELECT u.id, u.username, u.display_name, u.group_id, u.active,
      g.name AS group_name, g.permissions_json
    FROM users u JOIN groups g ON g.id = u.group_id
    WHERE u.id = ?
  `).get(userId);
}

async function initializeStorage() {
  await database.initialize();
  for (const group of defaultGroups) {
    await database.prepare(`
      INSERT OR IGNORE INTO groups (name, description, permissions_json, is_system)
      VALUES (@name, @description, @permissions_json, @is_system)
    `).run({
      name: group.name,
      description: group.description,
      permissions_json: JSON.stringify(group.permissions),
      is_system: group.isSystem ? 1 : 0
    });
  }
  const adminGroup = await database.prepare("SELECT id FROM groups WHERE name = 'System Admin'").get();
  if (!await database.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(bootstrapUsername)) {
    const password = hashPassword(bootstrapPassword);
    await database.prepare(`
      INSERT INTO users (username, display_name, password_salt, password_hash, group_id)
      VALUES (?, 'System Administrator', ?, ?, ?)
    `).run(bootstrapUsername, password.salt, password.hash, adminGroup.id);
  }
}

function safeUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    groupId: row.group_id,
    groupName: row.group_name,
    active: Boolean(row.active),
    permissions: JSON.parse(row.permissions_json)
  };
}

function ensureStorageInitialized() {
  if (startupError) return Promise.reject(startupError);
  if (!storageInitialization) {
    storageInitialization = initializeStorage().catch((error) => {
      storageInitialization = undefined;
      startupError = error;
      console.error("Receipt Recorder storage initialization failed:", error);
      throw error;
    });
  }
  return storageInitialization;
}

function signSession(userId, expiry) {
  return crypto.createHmac("sha256", sessionSecret)
    .update(`${userId}.${expiry}`)
    .digest("base64url");
}

async function authenticate(request, _response, next) {
  const token = request.cookies?.[sessionCookie];
  if (token) {
    const [userIdText, expiryText, signature] = token.split(".");
    const userId = Number(userIdText);
    const expiry = Number(expiryText);
    if (Number.isSafeInteger(userId) && Number.isSafeInteger(expiry) && expiry > Date.now() && signature) {
      const expected = Buffer.from(signSession(userId, expiry));
      const actual = Buffer.from(signature);
      if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) {
        const row = await findUserById(userId);
        if (row?.active) request.user = safeUser(row);
      }
    }
  }
  next();
}

function requireAuth(request, response, next) {
  if (!request.user) return response.status(401).json({ error: "Sign in to continue." });
  next();
}

function requirePermission(permission) {
  return (request, response, next) => {
    if (!request.user) return response.status(401).json({ error: "Sign in to continue." });
    if (!request.user.permissions.includes(permission)) {
      return response.status(403).json({ error: "Your user group does not have permission to do that." });
    }
    next();
  };
}

function isAdmin(row) {
  const groupPermissions = row?.permissions_json ? JSON.parse(row.permissions_json) : [];
  return row?.active && groupPermissions.includes("users:manage") && groupPermissions.includes("groups:manage");
}

async function hasActiveAdministrator(excludeUserId = null, changedGroupId = null, replacementPermissions = null) {
  const activeUsers = await database.prepare(`
    SELECT u.id, u.group_id, u.active, g.permissions_json
    FROM users u JOIN groups g ON g.id = u.group_id
    WHERE u.active = 1 AND u.id != COALESCE(?, -1)
      AND (? IS NULL OR u.group_id != ?)
  `).all(excludeUserId, changedGroupId, changedGroupId);
  if (changedGroupId !== null && replacementPermissions !== null) {
    const affectedUsers = await database.prepare("SELECT id FROM users WHERE active = 1 AND group_id = ?").all(changedGroupId);
    for (const user of affectedUsers) {
      if (user.id === excludeUserId) continue;
      if (replacementPermissions.includes("users:manage") && replacementPermissions.includes("groups:manage")) {
        return true;
      }
    }
  }
  return activeUsers.some(isAdmin);
}

function validDate(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function readDateRange(request, response) {
  const fromDate = typeof request.query.from === "string" ? request.query.from : "";
  const toDate = typeof request.query.to === "string" ? request.query.to : "";
  if ((fromDate && !validDate(fromDate)) || (toDate && !validDate(toDate))) {
    response.status(400).json({ error: "Dates must be valid YYYY-MM-DD values." });
    return null;
  }
  if (fromDate && toDate && fromDate > toDate) {
    response.status(400).json({ error: "The start date must not be after the end date." });
    return null;
  }
  return { fromDate, toDate };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function escapeExcelText(value) {
  return typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function getFilters(request, fields, response) {
  const range = readDateRange(request, response);
  if (!range) return null;
  const clauses = [];
  const values = { from_date: range.fromDate, to_date: range.toDate };
  if (range.fromDate) clauses.push("r.receipt_date >= @from_date");
  if (range.toDate) clauses.push("r.receipt_date <= @to_date");

  for (const [queryName, column] of [["siOrNumber", "r.si_or_number"], ["particulars", "r.particulars"]]) {
    const queryValue = request.query[queryName];
    if (typeof queryValue === "string" && queryValue.trim()) {
      const parameter = `filter_${queryName}`;
      values[parameter] = `%${escapeLike(queryValue.trim())}%`;
      clauses.push(`${column} LIKE @${parameter} ESCAPE char(92) COLLATE NOCASE`);
    }
  }

  const amountMin = request.query.amountMin;
  const amountMax = request.query.amountMax;
  if (amountMin !== undefined && amountMin !== "") {
    const amount = Number(amountMin);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000) {
      response.status(400).json({ error: "Minimum amount must be a number between 0 and 1,000,000,000." });
      return null;
    }
    values.amount_min = Math.round(amount * 100);
    clauses.push("r.amount_cents >= @amount_min");
  }
  if (amountMax !== undefined && amountMax !== "") {
    const amount = Number(amountMax);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000) {
      response.status(400).json({ error: "Maximum amount must be a number between 0 and 1,000,000,000." });
      return null;
    }
    values.amount_max = Math.round(amount * 100);
    clauses.push("r.amount_cents <= @amount_max");
  }
  if (amountMin !== undefined && amountMin !== "" && amountMax !== undefined && amountMax !== "" &&
    Number(amountMin) > Number(amountMax)) {
    response.status(400).json({ error: "The minimum amount must not be greater than the maximum amount." });
    return null;
  }

  const userId = request.query.userId;
  if (userId !== undefined && userId !== "") {
    if (!request.user.permissions.includes("receipts:read_all")) {
      response.status(403).json({ error: "Your user group cannot filter receipts by user." });
      return null;
    }
    if (!/^\d+$/.test(String(userId))) {
      response.status(400).json({ error: "Select a valid user." });
      return null;
    }
    values.filter_user_id = Number(userId);
    clauses.push("r.created_by = @filter_user_id");
  }

  const groupId = request.query.groupId;
  if (groupId !== undefined && groupId !== "") {
    if (!request.user.permissions.includes("receipts:read_all")) {
      response.status(403).json({ error: "Your user group cannot filter receipts by user group." });
      return null;
    }
    if (!/^\d+$/.test(String(groupId))) {
      response.status(400).json({ error: "Select a valid user group." });
      return null;
    }
    values.filter_group_id = Number(groupId);
    clauses.push("u.group_id = @filter_group_id");
  }

  const rawKeys = Object.keys(request.query).filter((key) => key.startsWith("cf_"));
  if (rawKeys.length > 50) {
    response.status(400).json({ error: "Use no more than 50 custom field filters at a time." });
    return null;
  }
  const activeIds = new Set(fields.map((field) => field.id));
  for (const key of rawKeys) {
    const idText = key.slice(3);
    const id = Number(idText);
    const filterValue = request.query[key];
    if (!/^\d+$/.test(idText) || !activeIds.has(id) || typeof filterValue !== "string" || filterValue.length > 500) {
      response.status(400).json({ error: "A custom field filter is invalid or no longer available." });
      return null;
    }
    values[`field_id_${id}`] = String(id);
    values[`field_value_${id}`] = `%${escapeLike(filterValue)}%`;
    clauses.push(`EXISTS (
      SELECT 1 FROM json_each(r.custom_values) custom
      WHERE custom.key = @field_id_${id}
        AND CAST(custom.value AS TEXT) LIKE @field_value_${id} ESCAPE char(92) COLLATE NOCASE
    )`);
  }

  if (!request.user.permissions.includes("receipts:read_all")) {
    if (!request.user.permissions.includes("receipts:read_own")) {
      response.status(403).json({ error: "Your user group cannot view receipts." });
      return null;
    }
    values.scope_user_id = request.user.id;
    clauses.push("r.created_by = @scope_user_id");
  }

  return { values, clauses };
}

async function getReceiptRows(filters) {
  const where = filters.clauses.length ? `WHERE ${filters.clauses.join(" AND ")}` : "";
  return database.prepare(`
    SELECT r.id, CAST(r.receipt_date AS TEXT) AS receipt_date,
      r.si_or_number, r.particulars, r.amount_cents,
      r.custom_values, r.created_by, r.created_at,
      COALESCE(u.display_name, r.created_by_name) AS creator_name
    FROM receipts r
    LEFT JOIN users u ON u.id = r.created_by
    ${where}
    ORDER BY r.receipt_date DESC, r.id DESC
  `).all(filters.values);
}

async function visibleFields() {
  return (await database.prepare(`
    SELECT id, label, field_type, required, options_json, active, sort_order
    FROM receipt_fields WHERE active = 1 ORDER BY sort_order, id
  `).all()).map((row) => ({
    id: row.id,
    label: row.label,
    type: row.field_type,
    required: Boolean(row.required),
    options: JSON.parse(row.options_json),
    sortOrder: row.sort_order
  }));
}

function validateCustomValues(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Custom field values must be an object." };
  }
  const availableIds = new Set(fields.map((field) => String(field.id)));
  for (const key of Object.keys(input)) {
    if (!availableIds.has(key)) return { error: "A custom field was changed or removed. Refresh the form and try again." };
  }
  const values = {};
  for (const field of fields) {
    const rawValue = input[String(field.id)];
    const value = rawValue === undefined || rawValue === null ? "" : String(rawValue).trim();
    if (field.required && !value) return { error: `${field.label} is required.` };
    if (!value) continue;
    if (value.length > 1000) return { error: `${field.label} must be 1,000 characters or fewer.` };
    if (field.type === "number" && (!Number.isFinite(Number(value)) || value.length > 40)) {
      return { error: `${field.label} must be a valid number.` };
    }
    if (field.type === "date" && !validDate(value)) return { error: `${field.label} must be a valid date.` };
    if (field.type === "select" && !field.options.includes(value)) {
      return { error: `Choose a valid option for ${field.label}.` };
    }
    values[String(field.id)] = value;
  }
  return { values };
}

function userCan(permission, receipt, user) {
  return user.permissions.includes(permission.replace("_own", "_all")) ||
    (user.permissions.includes(permission) && receipt.created_by === user.id);
}

function validatedPermissions(input) {
  if (!Array.isArray(input) || input.some((permission) => typeof permission !== "string" || !validPermissionKeys.has(permission))) {
    return null;
  }
  return [...new Set(input)];
}

function validateFieldInput(input) {
  const label = typeof input?.label === "string" ? input.label.trim() : "";
  const type = input?.type;
  if (!label || label.length > 60) return { error: "Field labels are required and must be 60 characters or fewer." };
  if (!["text", "number", "date", "select"].includes(type)) {
    return { error: "Choose a text, number, date, or dropdown field type." };
  }
  const options = type === "select" && Array.isArray(input.options)
    ? [...new Set(input.options.map((option) => typeof option === "string" ? option.trim() : "").filter(Boolean))]
    : [];
  if (type === "select" && (options.length < 2 || options.length > 50 || options.some((option) => option.length > 100))) {
    return { error: "Dropdown fields need 2–50 options, each no more than 100 characters." };
  }
  return {
    field: {
      label,
      type,
      required: Boolean(input.required),
      options,
      sortOrder: Number.isInteger(input.sortOrder) && input.sortOrder >= 0 ? input.sortOrder : 0
    }
  };
}

async function queryPermissionsForGroup(groupId) {
  return JSON.parse((await database.prepare("SELECT permissions_json FROM groups WHERE id = ?").get(groupId))?.permissions_json || "[]");
}

app.disable("x-powered-by");

function healthDetails() {
  return {
    status: startupError ? "degraded" : "ok",
    service: "receipt-recorder",
    version: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_REF || "local",
    database: database
      ? { configured: Boolean(database.remote), type: database.remote ? "postgresql" : "sqlite" }
      : { configured: false, type: null },
    environment: {
      ACCOUNTING_PASSWORD: Boolean(process.env.ACCOUNTING_PASSWORD),
      SESSION_SECRET: Boolean(process.env.SESSION_SECRET) && process.env.SESSION_SECRET.length >= 32,
      SUPABASE_DB_URL: Boolean(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL),
      NODE_ENV: process.env.NODE_ENV || null,
      VERCEL: Boolean(process.env.VERCEL)
    },
    error: startupError ? {
      name: startupError.name,
      message: startupError.message,
      code: startupError.code || null
    } : null
  };
}

app.get("/api/health", (_request, response) => response.status(startupError ? 503 : 200).json(healthDetails()));

app.get("/api/health/db", async (_request, response) => {
  if (startupError) return response.status(503).json(healthDetails());
  try {
    await ensureStorageInitialized();
    return response.json(healthDetails());
  } catch (_error) {
    return response.status(503).json(healthDetails());
  }
});

app.use((_request, _response, next) => {
  ensureStorageInitialized().then(() => next(), next);
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "32kb" }));
app.use((request, _response, next) => {
  const cookieHeader = request.headers.cookie || "";
  request.cookies = Object.fromEntries(cookieHeader.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([key]) => key));
  next();
});
app.use(authenticate);
app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: isProduction ? "1h" : 0 }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please try again in 15 minutes." }
});

app.get("/api/auth/me", requireAuth, (request, response) => response.json({ user: request.user }));

app.post("/api/auth/login", loginLimiter, async (request, response) => {
  const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const row = await database.prepare(`
    SELECT u.id, u.password_salt, u.password_hash, u.active
    FROM users u WHERE u.username = ? COLLATE NOCASE
  `).get(username);
  const passwordHash = crypto.scryptSync(password, row?.password_salt || "receipt-recorder-invalid-user", 64);
  const expectedHash = Buffer.from(row?.password_hash || "0".repeat(128), "hex");
  const valid = passwordHash.length === expectedHash.length && crypto.timingSafeEqual(passwordHash, expectedHash);
  if (!row?.active || !valid) return response.status(401).json({ error: "Incorrect username or password, or this account is disabled." });

  const expiry = Date.now() + 8 * 60 * 60 * 1000;
  const sessionValue = `${row.id}.${expiry}.${signSession(row.id, expiry)}`;
  response.setHeader("Set-Cookie", [
    `${sessionCookie}=${sessionValue}; Max-Age=28800; Path=/; HttpOnly; SameSite=Strict${isProduction ? "; Secure" : ""}`
  ]);
  response.json({ user: safeUser(await findUserById(row.id)) });
});

app.post("/api/auth/logout", (_request, response) => {
  response.setHeader("Set-Cookie", [
    `${sessionCookie}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${isProduction ? "; Secure" : ""}`
  ]);
  response.json({ authenticated: false });
});

app.get("/api/groups", requireAuth, async (_request, response) => {
  const groups = (await database.prepare(`
    SELECT g.id, g.name, g.description, g.permissions_json, g.is_system,
      COUNT(u.id) AS user_count
    FROM groups g LEFT JOIN users u ON u.group_id = g.id AND u.active = 1
    GROUP BY g.id ORDER BY g.name COLLATE NOCASE
  `).all()).map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    permissions: JSON.parse(group.permissions_json),
    isSystem: Boolean(group.is_system),
    userCount: group.user_count
  }));
  response.json({ groups });
});

app.get("/api/users/directory", requirePermission("receipts:read_all"), async (_request, response) => {
  const users = (await database.prepare(`
    SELECT u.id, u.username, u.display_name, u.group_id, u.active, g.name AS group_name
    FROM users u JOIN groups g ON g.id = u.group_id
    ORDER BY u.display_name COLLATE NOCASE
  `).all()).map((user) => ({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    groupId: user.group_id,
    groupName: user.group_name,
    active: Boolean(user.active)
  }));
  response.json({ users });
});

app.get("/api/fields", requireAuth, async (_request, response) => response.json({ fields: await visibleFields() }));

app.get("/api/receipts", requireAuth, async (request, response) => {
  const filters = getFilters(request, await visibleFields(), response);
  if (!filters) return;
  const receipts = (await getReceiptRows(filters)).map((row) => ({
    id: row.id,
    date: row.receipt_date,
    siOrNumber: row.si_or_number,
    particulars: row.particulars,
    amount: row.amount_cents / 100,
    customValues: JSON.parse(row.custom_values),
    createdBy: row.created_by,
    creatorName: row.creator_name,
    createdAt: row.created_at,
    canEdit: userCan("receipts:edit_own", row, request.user),
    canDelete: userCan("receipts:delete_own", row, request.user)
  }));
  response.json({ receipts });
});

app.post("/api/receipts", requirePermission("receipts:create"), async (request, response) => {
  const { date, siOrNumber, particulars, amount } = request.body || {};
  const amountNumber = typeof amount === "number" ? amount : Number(amount);
  if (!validDate(date)) return response.status(400).json({ error: "Enter a valid receipt date." });
  if (typeof siOrNumber !== "string" || !siOrNumber.trim() || siOrNumber.trim().length > 80) {
    return response.status(400).json({ error: "SI/OR number is required and must be 80 characters or fewer." });
  }
  if (typeof particulars !== "string" || !particulars.trim() || particulars.trim().length > 1000) {
    return response.status(400).json({ error: "Particulars are required and must be 1,000 characters or fewer." });
  }
  if (!Number.isFinite(amountNumber) || amountNumber <= 0 || amountNumber > 1000000000) {
    return response.status(400).json({ error: "Amount must be greater than zero and no more than 1,000,000,000." });
  }
  const customResult = validateCustomValues(request.body?.customValues || {}, await visibleFields());
  if (customResult.error) return response.status(400).json({ error: customResult.error });

  const result = await database.prepare(`
    INSERT INTO receipts (receipt_date, si_or_number, particulars, amount_cents, custom_values, created_by, created_by_name)
    VALUES (@date, @si_or_number, @particulars, @amount_cents, @custom_values, @created_by, @created_by_name)
  `).run({
    date,
    si_or_number: siOrNumber.trim(),
    particulars: particulars.trim(),
    amount_cents: Math.round(amountNumber * 100),
    custom_values: JSON.stringify(customResult.values),
    created_by: request.user.id,
    created_by_name: request.user.displayName
  });
  response.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.put("/api/receipts/:id", requireAuth, async (request, response) => {
  const receiptId = Number(request.params.id);
  if (!Number.isSafeInteger(receiptId) || receiptId <= 0) return response.status(400).json({ error: "Select a valid receipt." });
  const receipt = await database.prepare("SELECT id, created_by FROM receipts WHERE id = ?").get(receiptId);
  if (!receipt) return response.status(404).json({ error: "Receipt not found." });
  if (!userCan("receipts:edit_own", receipt, request.user)) {
    return response.status(403).json({ error: "Your user group cannot edit this receipt." });
  }
  const { date, siOrNumber, particulars, amount } = request.body || {};
  const amountNumber = typeof amount === "number" ? amount : Number(amount);
  if (!validDate(date)) return response.status(400).json({ error: "Enter a valid receipt date." });
  if (typeof siOrNumber !== "string" || !siOrNumber.trim() || siOrNumber.trim().length > 80) {
    return response.status(400).json({ error: "SI/OR number is required and must be 80 characters or fewer." });
  }
  if (typeof particulars !== "string" || !particulars.trim() || particulars.trim().length > 1000) {
    return response.status(400).json({ error: "Particulars are required and must be 1,000 characters or fewer." });
  }
  if (!Number.isFinite(amountNumber) || amountNumber <= 0 || amountNumber > 1000000000) {
    return response.status(400).json({ error: "Amount must be greater than zero and no more than 1,000,000,000." });
  }
  const customResult = validateCustomValues(request.body?.customValues || {}, await visibleFields());
  if (customResult.error) return response.status(400).json({ error: customResult.error });
  await database.prepare(`
    UPDATE receipts
    SET receipt_date = @date, si_or_number = @si_or_number, particulars = @particulars,
      amount_cents = @amount_cents, custom_values = @custom_values,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id: receiptId,
    date,
    si_or_number: siOrNumber.trim(),
    particulars: particulars.trim(),
    amount_cents: Math.round(amountNumber * 100),
    custom_values: JSON.stringify(customResult.values)
  });
  response.json({ updated: true });
});

app.delete("/api/receipts/:id", requireAuth, async (request, response) => {
  const receiptId = Number(request.params.id);
  if (!Number.isSafeInteger(receiptId) || receiptId <= 0) return response.status(400).json({ error: "Select a valid receipt." });
  const receipt = await database.prepare("SELECT id, created_by FROM receipts WHERE id = ?").get(receiptId);
  if (!receipt) return response.status(404).json({ error: "Receipt not found." });
  if (!userCan("receipts:delete_own", receipt, request.user)) {
    return response.status(403).json({ error: "Your user group cannot delete this receipt." });
  }
  await database.prepare("DELETE FROM receipts WHERE id = ?").run(receiptId);
  response.json({ deleted: true });
});

app.get("/api/admin/permissions", requirePermission("groups:manage"), (_request, response) => response.json({ permissions }));

app.get("/api/admin/users", requirePermission("users:manage"), async (_request, response) => {
  const users = (await database.prepare(`
    SELECT u.id, u.username, u.display_name, u.group_id, u.active, u.created_at,
      g.name AS group_name
    FROM users u JOIN groups g ON g.id = u.group_id
    ORDER BY u.display_name COLLATE NOCASE
  `).all()).map((user) => ({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    groupId: user.group_id,
    groupName: user.group_name,
    active: Boolean(user.active),
    createdAt: user.created_at
  }));
  response.json({ users });
});

app.post("/api/admin/users", requirePermission("users:manage"), async (request, response) => {
  const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
  const displayName = typeof request.body?.displayName === "string" ? request.body.displayName.trim() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const groupId = Number(request.body?.groupId);
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) return response.status(400).json({ error: "Username must be 3–40 characters: letters, numbers, dots, dashes, or underscores." });
  if (!displayName || displayName.length > 80) return response.status(400).json({ error: "Enter a display name of 1–80 characters." });
  if (password.length < 10 || password.length > 200) return response.status(400).json({ error: "New passwords must be at least 10 characters and no more than 200 characters." });
  if (!Number.isSafeInteger(groupId) || !await database.prepare("SELECT id FROM groups WHERE id = ?").get(groupId)) {
    return response.status(400).json({ error: "Choose a valid user group." });
  }
  const credentials = hashPassword(password);
  try {
    const result = await database.prepare(`
      INSERT INTO users (username, display_name, password_salt, password_hash, group_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, displayName, credentials.salt, credentials.hash, groupId);
    response.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") return response.status(409).json({ error: "That username is already in use." });
    throw error;
  }
});

app.put("/api/admin/users/:id", requirePermission("users:manage"), async (request, response) => {
  const userId = Number(request.params.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return response.status(400).json({ error: "Select a valid user." });
  const current = await database.prepare("SELECT id, group_id, active FROM users WHERE id = ?").get(userId);
  if (!current) return response.status(404).json({ error: "User not found." });
  const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
  const displayName = typeof request.body?.displayName === "string" ? request.body.displayName.trim() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const groupId = Number(request.body?.groupId);
  const active = request.body?.active === undefined ? Boolean(current.active) : request.body.active === true;
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) return response.status(400).json({ error: "Username must be 3–40 characters: letters, numbers, dots, dashes, or underscores." });
  if (!displayName || displayName.length > 80) return response.status(400).json({ error: "Enter a display name of 1–80 characters." });
  if (password && (password.length < 10 || password.length > 200)) return response.status(400).json({ error: "New passwords must be at least 10 characters and no more than 200 characters." });
  if (!Number.isSafeInteger(groupId) || !await database.prepare("SELECT id FROM groups WHERE id = ?").get(groupId)) {
    return response.status(400).json({ error: "Choose a valid user group." });
  }
  if (userId === request.user.id && (!active || groupId !== current.group_id)) {
    return response.status(400).json({ error: "You cannot disable or move your own account to a different group." });
  }
  const oldPermissions = await queryPermissionsForGroup(current.group_id);
  const newPermissions = await queryPermissionsForGroup(groupId);
  const losesAdminAccess = oldPermissions.includes("users:manage") && oldPermissions.includes("groups:manage") &&
    !(newPermissions.includes("users:manage") && newPermissions.includes("groups:manage"));
  if (current.active && (!active || losesAdminAccess) && !await hasActiveAdministrator(userId)) {
    return response.status(400).json({ error: "You cannot remove or disable the last active system administrator." });
  }

  const credentials = password ? hashPassword(password) : null;
  try {
    await database.prepare(`
      UPDATE users
      SET username = @username, display_name = @display_name, group_id = @group_id,
        active = @active,
        password_salt = COALESCE(@password_salt, password_salt),
        password_hash = COALESCE(@password_hash, password_hash)
      WHERE id = @id
    `).run({
      id: userId,
      username,
      display_name: displayName,
      group_id: groupId,
      active: active ? 1 : 0,
      password_salt: credentials?.salt || null,
      password_hash: credentials?.hash || null
    });
    response.json({ updated: true });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") return response.status(409).json({ error: "That username is already in use." });
    throw error;
  }
});

app.delete("/api/admin/users/:id", requirePermission("users:manage"), async (request, response) => {
  const userId = Number(request.params.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return response.status(400).json({ error: "Select a valid user." });
  const target = await findUserById(userId);
  if (!target) return response.status(404).json({ error: "User not found." });
  if (userId === request.user.id) return response.status(400).json({ error: "You cannot delete your own account." });
  if (isAdmin(target) && !await hasActiveAdministrator(userId)) {
    return response.status(400).json({ error: "You cannot delete the last active system administrator." });
  }
  await database.prepare("DELETE FROM users WHERE id = ?").run(userId);
  response.json({ deleted: true });
});

app.post("/api/admin/groups", requirePermission("groups:manage"), async (request, response) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const description = typeof request.body?.description === "string" ? request.body.description.trim() : "";
  const groupPermissions = validatedPermissions(request.body?.permissions);
  if (!name || name.length > 60) return response.status(400).json({ error: "Group name is required and must be 60 characters or fewer." });
  if (description.length > 240) return response.status(400).json({ error: "Group description must be 240 characters or fewer." });
  if (!groupPermissions) return response.status(400).json({ error: "Choose valid group permissions." });
  try {
    const result = await database.prepare(`
      INSERT INTO groups (name, description, permissions_json, is_system)
      VALUES (?, ?, ?, 0)
    `).run(name, description, JSON.stringify(groupPermissions));
    response.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") return response.status(409).json({ error: "That group name is already in use." });
    throw error;
  }
});

app.put("/api/admin/groups/:id", requirePermission("groups:manage"), async (request, response) => {
  const groupId = Number(request.params.id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return response.status(400).json({ error: "Select a valid group." });
  const group = await database.prepare("SELECT id, is_system FROM groups WHERE id = ?").get(groupId);
  if (!group) return response.status(404).json({ error: "Group not found." });
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const description = typeof request.body?.description === "string" ? request.body.description.trim() : "";
  const groupPermissions = validatedPermissions(request.body?.permissions);
  if (!name || name.length > 60) return response.status(400).json({ error: "Group name is required and must be 60 characters or fewer." });
  if (group.is_system) {
    const existingName = (await database.prepare("SELECT name FROM groups WHERE id = ?").get(groupId)).name;
    if (name.toLowerCase() !== existingName.toLowerCase()) {
      return response.status(400).json({ error: "Default system group names cannot be changed." });
    }
  }
  if (description.length > 240) return response.status(400).json({ error: "Group description must be 240 characters or fewer." });
  if (!groupPermissions) return response.status(400).json({ error: "Choose valid group permissions." });
  const currentPermissions = await queryPermissionsForGroup(groupId);
  const removesAdminAccess = currentPermissions.includes("users:manage") && currentPermissions.includes("groups:manage") &&
    !(groupPermissions.includes("users:manage") && groupPermissions.includes("groups:manage"));
  if (removesAdminAccess && !await hasActiveAdministrator(null, groupId, groupPermissions)) {
    return response.status(400).json({ error: "This change would remove the last active system administrator." });
  }
  try {
    await database.prepare(`
      UPDATE groups SET name = ?, description = ?, permissions_json = ? WHERE id = ?
    `).run(name, description, JSON.stringify(groupPermissions), groupId);
    response.json({ updated: true });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") return response.status(409).json({ error: "That group name is already in use." });
    throw error;
  }
});

app.delete("/api/admin/groups/:id", requirePermission("groups:manage"), async (request, response) => {
  const groupId = Number(request.params.id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return response.status(400).json({ error: "Select a valid group." });
  const group = await database.prepare("SELECT id, is_system FROM groups WHERE id = ?").get(groupId);
  if (!group) return response.status(404).json({ error: "Group not found." });
  if (group.is_system) return response.status(400).json({ error: "Default system groups cannot be deleted. Edit their permissions instead." });
  if (await database.prepare("SELECT id FROM users WHERE group_id = ? LIMIT 1").get(groupId)) {
    return response.status(400).json({ error: "Reassign or delete this group's user accounts before deleting it." });
  }
  await database.prepare("DELETE FROM groups WHERE id = ?").run(groupId);
  response.json({ deleted: true });
});

app.get("/api/admin/fields", requirePermission("fields:manage"), async (_request, response) => {
  const fields = (await database.prepare(`
    SELECT id, label, field_type, required, options_json, active, sort_order
    FROM receipt_fields ORDER BY sort_order, id
  `).all()).map((field) => ({
    id: field.id,
    label: field.label,
    type: field.field_type,
    required: Boolean(field.required),
    options: JSON.parse(field.options_json),
    active: Boolean(field.active),
    sortOrder: field.sort_order
  }));
  response.json({ fields });
});

app.post("/api/admin/fields", requirePermission("fields:manage"), async (request, response) => {
  const validated = validateFieldInput(request.body);
  if (validated.error) return response.status(400).json({ error: validated.error });
  const field = validated.field;
  const result = await database.prepare(`
    INSERT INTO receipt_fields (label, field_type, required, options_json, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(field.label, field.type, field.required ? 1 : 0, JSON.stringify(field.options), field.sortOrder);
  response.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.put("/api/admin/fields/:id", requirePermission("fields:manage"), async (request, response) => {
  const fieldId = Number(request.params.id);
  if (!Number.isSafeInteger(fieldId) || fieldId <= 0) return response.status(400).json({ error: "Select a valid field." });
  if (!await database.prepare("SELECT id FROM receipt_fields WHERE id = ?").get(fieldId)) return response.status(404).json({ error: "Field not found." });
  const validated = validateFieldInput(request.body);
  if (validated.error) return response.status(400).json({ error: validated.error });
  const field = validated.field;
  await database.prepare(`
    UPDATE receipt_fields
    SET label = ?, field_type = ?, required = ?, options_json = ?, sort_order = ?
    WHERE id = ?
  `).run(field.label, field.type, field.required ? 1 : 0, JSON.stringify(field.options), field.sortOrder, fieldId);
  response.json({ updated: true });
});

app.delete("/api/admin/fields/:id", requirePermission("fields:manage"), async (request, response) => {
  const fieldId = Number(request.params.id);
  if (!Number.isSafeInteger(fieldId) || fieldId <= 0) return response.status(400).json({ error: "Select a valid field." });
  const result = await database.prepare("UPDATE receipt_fields SET active = 0 WHERE id = ? AND active = 1").run(fieldId);
  if (result.changes === 0) return response.status(404).json({ error: "Active field not found." });
  response.json({ deactivated: true });
});

app.get("/api/receipts/export.xlsx", requirePermission("receipts:export"), async (request, response, next) => {
  const filters = getFilters(request, await visibleFields(), response);
  if (!filters) return;
  try {
    const receipts = await getReceiptRows(filters);
    const fields = await database.prepare(`
      SELECT id, label, active FROM receipt_fields ORDER BY sort_order, id
    `).all();
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Receipt Recorder";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Receipts", {
      views: [{ state: "frozen", ySplit: 1 }]
    });
    const baseColumns = [
      { header: "Date", key: "date", width: 16 },
      { header: "SI/OR Number", key: "siOrNumber", width: 22 },
      { header: "Particulars", key: "particulars", width: 48 },
      { header: "Amount (PHP)", key: "amount", width: 18 },
      { header: "Entered By", key: "enteredBy", width: 24 }
    ];
    const customColumns = fields.map((field) => ({
      header: field.active ? field.label : `${field.label} (Archived)`,
      key: `custom_${field.id}`,
      width: Math.min(32, Math.max(16, field.label.length + 4))
    }));
    sheet.columns = [...baseColumns, ...customColumns];
    sheet.autoFilter = `A1:${sheet.getColumn(sheet.columnCount).letter}${Math.max(1, receipts.length + 1)}`;
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF163B3A" } };
    for (const receipt of receipts) {
      const customValues = JSON.parse(receipt.custom_values);
      const row = {
        date: new Date(`${receipt.receipt_date}T00:00:00.000Z`),
        siOrNumber: escapeExcelText(receipt.si_or_number),
        particulars: escapeExcelText(receipt.particulars),
        amount: receipt.amount_cents / 100,
        enteredBy: escapeExcelText(receipt.creator_name || "Former user")
      };
      for (const field of fields) row[`custom_${field.id}`] = escapeExcelText(customValues[String(field.id)] || "");
      sheet.addRow(row);
    }
    sheet.getColumn("date").numFmt = "yyyy-mm-dd";
    sheet.getColumn("amount").numFmt = '"₱"#,##0.00';
    sheet.addRow({});
    const totalRow = sheet.addRow({
      particulars: "TOTAL",
      amount: { formula: `SUM(D2:D${Math.max(2, receipts.length + 1)})` }
    });
    totalRow.font = { bold: true };
    totalRow.getCell("amount").numFmt = '"₱"#,##0.00';
    const filename = `receipts-${new Date().toISOString().slice(0, 10)}.xlsx`;
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(response);
    response.end();
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error("Request failed:", error);
  if (response.headersSent) return;
  if (error.type === "entity.parse.failed") {
    return response.status(400).json({ error: "The request body must contain valid JSON." });
  }
  if (error.status === 413 || error.status === 415) {
    return response.status(error.status).json({ error: "The request body is too large or has an unsupported format." });
  }
  response.status(500).json({ error: "The request could not be completed. Please try again." });
});

let httpServer;
if (require.main === module) {
  start().catch((error) => {
    console.error("Receipt Recorder could not start:", error);
    process.exitCode = 1;
  });
}

async function start() {
  await ensureStorageInitialized();
  httpServer = app.listen(port, "0.0.0.0");
  await new Promise((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  console.log(`Receipt Recorder listening on http://localhost:${httpServer.address().port}`);
  console.log(database.remote
    ? "Database: Supabase PostgreSQL"
    : `Local SQLite database: ${database.sqlitePath}`);
  console.log(`Initial administrator: ${bootstrapUsername}`);
  return httpServer;
}

app.app = app;
app.start = start;
app.database = database;
Object.defineProperty(app, "httpServer", {
  enumerable: true,
  get() {
    return httpServer;
  }
});

module.exports = app;
