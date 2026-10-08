const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");

process.env.ACCOUNTING_PASSWORD = "bootstrap-admin-password-test";
process.env.ADMIN_USERNAME = "admin";
process.env.SESSION_SECRET = "receipt-recorder-test-session-secret-32";
process.env.NODE_ENV = "test";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-recorder-test-"));
process.env.PORT = "0";
process.env.SUPABASE_DB_URL = "";
process.env.DATABASE_URL = "";
process.env.SUPABASE_URL = "https://receipt-recorder-test.supabase.co";

const { after, before, test } = require("node:test");
const server = require("../app-server");
assert.equal(require("../server"), server);
const dataDirectory = process.env.DATA_DIR;
let baseUrl;
let adminCookie;
let officerCookie;
let accountingCookie;
let bobCookie;
let customFieldId;
let bobReceiptId;
let aliceId;
let fieldOfficerGroupId;

async function post(pathname, payload, cookie) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(payload)
  });
}

async function json(response) {
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

async function login(username, password) {
  const response = await post("/api/auth/login", { username, password });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

before(async () => {
  await server.start();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  adminCookie = await login("admin", process.env.ACCOUNTING_PASSWORD);
});

after(async () => {
  if (server.httpServer) {
    server.httpServer.closeAllConnections();
    server.httpServer.close();
    await once(server.httpServer, "close");
  }
  await server.database.close();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

test("login is required and user-group permissions isolate field-officer receipts", async () => {
  const denied = await fetch(`${baseUrl}/api/receipts`);
  assert.equal(denied.status, 401);
  const incorrect = await post("/api/auth/login", { username: "admin", password: "incorrect" });
  assert.equal(incorrect.status, 401);

  const { groups } = await json(await fetch(`${baseUrl}/api/groups`, { headers: { cookie: adminCookie } }));
  const officerGroup = groups.find((group) => group.name === "Field Officer");
  const accountingGroup = groups.find((group) => group.name === "Accounting");
  assert.ok(officerGroup);
  fieldOfficerGroupId = officerGroup.id;
  assert.ok(accountingGroup);

  const field = await json(await post("/api/admin/fields", {
    label: "Department",
    type: "text",
    required: true
  }, adminCookie));
  customFieldId = field.id;

  for (const [username, displayName] of [["alice", "Alice Officer"], ["bob", "Bob Officer"]]) {
    const created = await post("/api/admin/users", {
      username,
      displayName,
      password: "Field-officer-password-01",
      groupId: officerGroup.id
    }, adminCookie);
    assert.equal(created.status, 201);
    const { id } = await created.json();
    if (username === "alice") aliceId = id;
  }
  const accountant = await post("/api/admin/users", {
    username: "accountant",
    displayName: "Accounting Officer",
    password: "Accounting-password-01",
    groupId: accountingGroup.id
  }, adminCookie);
  assert.equal(accountant.status, 201);

  officerCookie = await login("alice", "Field-officer-password-01");
  const invalidReceipt = await post("/api/receipts", {
    date: "2026-10-07",
    siOrNumber: "INVALID-001",
    particulars: "Missing required custom field",
    amount: 12.34
  }, officerCookie);
  assert.equal(invalidReceipt.status, 400);

  const firstReceipt = await json(await post("/api/receipts", {
    date: "2026-10-07",
    siOrNumber: "FIELD-001",
    particulars: "Office supplies",
    amount: 123.45,
    customValues: { [customFieldId]: "Finance" }
  }, officerCookie));
  assert.ok(firstReceipt.id);

  bobCookie = await login("bob", "Field-officer-password-01");
  const bobReceipt = await json(await post("/api/receipts", {
    date: "2026-10-08",
    siOrNumber: "FIELD-002",
    particulars: "Travel costs",
    amount: 20,
    customValues: { [customFieldId]: "Operations" }
  }, bobCookie));
  bobReceiptId = bobReceipt.id;

  const officerList = await json(await fetch(`${baseUrl}/api/receipts`, { headers: { cookie: officerCookie } }));
  assert.deepEqual(officerList.receipts.map((receipt) => receipt.siOrNumber), ["FIELD-001"]);
  assert.equal(officerList.receipts[0].customValues[String(customFieldId)], "Finance");
  const deniedEdit = await fetch(`${baseUrl}/api/receipts/${bobReceiptId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: officerCookie },
    body: JSON.stringify({
      date: "2026-10-08",
      siOrNumber: "FIELD-002",
      particulars: "Attempt to edit another user's receipt",
      amount: 20,
      customValues: { [customFieldId]: "Operations" }
    })
  });
  assert.equal(deniedEdit.status, 403);
  const deniedDelete = await fetch(`${baseUrl}/api/receipts/${bobReceiptId}`, {
    method: "DELETE",
    headers: { cookie: officerCookie }
  });
  assert.equal(deniedDelete.status, 403);

  const accountantCookieValue = await login("accountant", "Accounting-password-01");
  accountingCookie = accountantCookieValue;
  const accountantList = await json(await fetch(`${baseUrl}/api/receipts`, { headers: { cookie: accountingCookie } }));
  assert.equal(accountantList.receipts.length, 2);
  assert.equal(accountantList.receipts[0].creatorName, "Bob Officer");

  const group = await json(await post("/api/admin/groups", {
    name: "Read only",
    description: "May view own receipts.",
    permissions: ["receipts:read_own"]
  }, adminCookie));
  const updatedGroup = await fetch(`${baseUrl}/api/admin/groups/${group.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      name: "Read only",
      description: "May view or export own receipts.",
      permissions: ["receipts:read_own", "receipts:export"]
    })
  });
  assert.equal(updatedGroup.status, 200);
  const deleteInUse = await fetch(`${baseUrl}/api/admin/groups/${officerGroup.id}`, {
    method: "DELETE",
    headers: { cookie: adminCookie }
  });
  assert.equal(deleteInUse.status, 400);
});

test("custom field filters produce an Excel file with the matching records and columns", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/receipts/export.xlsx`);
  assert.equal(unauthenticated.status, 401);

  const invalidRange = await fetch(`${baseUrl}/api/receipts/export.xlsx?from=2026-10-08&to=2026-10-01`, {
    headers: { cookie: accountingCookie }
  });
  assert.equal(invalidRange.status, 400);

  const params = new URLSearchParams({
    from: "2026-10-01",
    to: "2026-10-31",
    siOrNumber: "FIELD-001",
    [`cf_${customFieldId}`]: "Finance",
    amountMin: "100",
    amountMax: "200",
    userId: String(aliceId),
    groupId: String(fieldOfficerGroupId)
  });
  const exported = await fetch(`${baseUrl}/api/receipts/export.xlsx?${params}`, {
    headers: { cookie: accountingCookie }
  });
  assert.equal(exported.status, 200);
  assert.equal(
    exported.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await exported.arrayBuffer()));
  const sheet = workbook.getWorksheet("Receipts");
  const exportedDate = sheet.getRow(2).getCell(1).value;
  assert.equal(sheet.getRow(1).getCell(6).value, "Department");
  assert.ok(exportedDate instanceof Date);
  assert.equal(exportedDate.toISOString().slice(0, 10), "2026-10-07");
  assert.equal(sheet.getRow(2).getCell(2).value, "FIELD-001");
  assert.equal(sheet.getRow(2).getCell(6).value, "Finance");
  assert.equal(sheet.getRow(4).getCell(4).value.formula, "SUM(D2:D2)");

  const emptyFilter = await fetch(`${baseUrl}/api/receipts/export.xlsx?cf_${customFieldId}=DoesNotExist`, {
    headers: { cookie: accountingCookie }
  });
  assert.equal(emptyFilter.status, 200);
  const emptyWorkbook = new ExcelJS.Workbook();
  await emptyWorkbook.xlsx.load(Buffer.from(await emptyFilter.arrayBuffer()));
  assert.equal(emptyWorkbook.getWorksheet("Receipts").getRow(2).getCell(2).value, null);
});

test("administrators cannot remove their last active administrator access", async () => {
  const { user } = await json(await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: adminCookie } }));
  const groupUpdate = await fetch(`${baseUrl}/api/admin/groups/${user.groupId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      name: "System Admin",
      description: "Remove all admin access",
      permissions: ["receipts:read_all"]
    })
  });
  assert.equal(groupUpdate.status, 400);

  const selfDisable = await fetch(`${baseUrl}/api/admin/users/${user.id}`, {
    method: "DELETE",
    headers: { cookie: adminCookie }
  });
  assert.equal(selfDisable.status, 400);
});

test("deleting a user revokes the account and preserves receipt attribution", async () => {
  const { users } = await json(await fetch(`${baseUrl}/api/admin/users`, { headers: { cookie: adminCookie } }));
  const bob = users.find((user) => user.username === "bob");
  assert.ok(bob);

  const deleted = await fetch(`${baseUrl}/api/admin/users/${bob.id}`, {
    method: "DELETE",
    headers: { cookie: adminCookie }
  });
  assert.equal(deleted.status, 200);
  const deniedLogin = await post("/api/auth/login", {
    username: "bob",
    password: "Field-officer-password-01"
  });
  assert.equal(deniedLogin.status, 401);

  const receipt = await json(await fetch(`${baseUrl}/api/receipts`, { headers: { cookie: accountingCookie } }));
  const savedReceipt = receipt.receipts.find((entry) => entry.id === bobReceiptId);
  assert.equal(savedReceipt.creatorName, "Bob Officer");
});

test("bulk user template and partial import enforce a first-sign-in password change", async () => {
  const unauthenticatedTemplate = await fetch(`${baseUrl}/api/admin/users/template.xlsx`);
  assert.equal(unauthenticatedTemplate.status, 401);

  const templateResponse = await fetch(`${baseUrl}/api/admin/users/template.xlsx`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(templateResponse.status, 200);
  assert.match(templateResponse.headers.get("content-disposition"), /user-upload-template\.xlsx/);
  const templateWorkbook = new ExcelJS.Workbook();
  await templateWorkbook.xlsx.load(Buffer.from(await templateResponse.arrayBuffer()));
  assert.deepEqual(templateWorkbook.getWorksheet("Users").getRow(1).values.slice(1), [
    "Username", "Full Name", "User Group", "Temporary Password"
  ]);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Users");
  sheet.addRow(["Username", "Full Name", "User Group", "Temporary Password"]);
  sheet.addRow(["bulkstaff", "Bulk Staff", "Field Officer", "Temporary-password-01"]);
  sheet.addRow(["bulkstaff", "Duplicate Staff", "Field Officer", "Temporary-password-02"]);
  sheet.addRow(["badgroup", "Unknown Group", "Nonexistent Group", "Temporary-password-03"]);
  sheet.addRow(["bad name", "Invalid Username", "Field Officer", "Temporary-password-04"]);
  const upload = await fetch(`${baseUrl}/api/admin/users/bulk`, {
    method: "POST",
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      cookie: adminCookie
    },
    body: Buffer.from(await workbook.xlsx.writeBuffer())
  });
  assert.equal(upload.status, 200);
  const importResult = await upload.json();
  assert.equal(importResult.created, 1);
  assert.equal(importResult.skipped, 3);
  assert.deepEqual(importResult.results.map((result) => result.status), [
    "created", "skipped", "skipped", "skipped"
  ]);
  assert.equal(importResult.results[0].row, 2);
  assert.equal(importResult.results[0].username, "bulkstaff");
  assert.ok(importResult.results[1].message.includes("already in use"));
  assert.ok(importResult.results[2].message.includes("existing group"));

  const importedLogin = await post("/api/auth/login", {
    username: "bulkstaff",
    password: "Temporary-password-01"
  });
  assert.equal(importedLogin.status, 200);
  const importedSession = importedLogin.headers.get("set-cookie").split(";")[0];
  const { user } = await json(await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: importedSession }
  }));
  assert.equal(user.mustChangePassword, true);

  const blocked = await fetch(`${baseUrl}/api/receipts`, { headers: { cookie: importedSession } });
  assert.equal(blocked.status, 403);

  const rejectedPasswordChange = await post("/api/auth/change-password", {
    password: "Temporary-password-01"
  }, importedSession);
  assert.equal(rejectedPasswordChange.status, 400);
  const passwordChange = await post("/api/auth/change-password", {
    password: "Permanent-password-01"
  }, importedSession);
  assert.equal(passwordChange.status, 200);
  assert.equal((await passwordChange.json()).username, "bulkstaff");
  assert.match(passwordChange.headers.get("set-cookie"), /Max-Age=0/);
  const signedOut = await fetch(`${baseUrl}/api/receipts`, { headers: { cookie: importedSession } });
  assert.equal(signedOut.status, 401);

  const newPassword = await post("/api/auth/login", {
    username: "bulkstaff",
    password: "Permanent-password-01"
  });
  assert.equal(newPassword.status, 200);
  const newSession = newPassword.headers.get("set-cookie").split(";")[0];
  const { user: updatedUser } = await json(await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: newSession }
  }));
  assert.equal(updatedUser.mustChangePassword, false);
  const allowed = await fetch(`${baseUrl}/api/receipts`, { headers: { cookie: newSession } });
  assert.equal(allowed.status, 200);
});

test("disabling a user blocks sign-in and revokes sessions, including after re-enabling", async () => {
  const aliceSession = await login("alice", "Field-officer-password-01");
  const disable = await fetch(`${baseUrl}/api/admin/users/${aliceId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      username: "alice",
      displayName: "Alice Officer",
      groupId: fieldOfficerGroupId,
      active: false
    })
  });
  assert.equal(disable.status, 200);

  const disabledList = await json(await fetch(`${baseUrl}/api/admin/users`, {
    headers: { cookie: adminCookie }
  }));
  assert.equal(disabledList.users.find((user) => user.id === aliceId).active, false);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: aliceSession } })).status, 401);
  assert.equal((await post("/api/auth/login", {
    username: "alice",
    password: "Field-officer-password-01"
  })).status, 401);

  const enable = await fetch(`${baseUrl}/api/admin/users/${aliceId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      username: "alice",
      displayName: "Alice Officer",
      groupId: fieldOfficerGroupId,
      active: true
    })
  });
  assert.equal(enable.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: aliceSession } })).status, 401);
  const enabledLogin = await post("/api/auth/login", {
    username: "alice",
    password: "Field-officer-password-01"
  });
  assert.equal(enabledLogin.status, 200);
});

test("administrator password reset forces a new password and revokes all account sessions", async () => {
  const secondAliceSession = await login("alice", "Field-officer-password-01");
  const reset = await fetch(`${baseUrl}/api/admin/users/${aliceId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      username: "alice",
      displayName: "Alice Officer",
      groupId: fieldOfficerGroupId,
      password: "Temporary-admin-reset-01"
    })
  });
  assert.equal(reset.status, 200);

  for (const cookie of [officerCookie, secondAliceSession]) {
    const invalidated = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
    assert.equal(invalidated.status, 401);
  }

  const temporaryLogin = await post("/api/auth/login", {
    username: "alice",
    password: "Temporary-admin-reset-01"
  });
  assert.equal(temporaryLogin.status, 200);
  const temporarySession = temporaryLogin.headers.get("set-cookie").split(";")[0];
  const { user } = await json(await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: temporarySession }
  }));
  assert.equal(user.mustChangePassword, true);
  const blocked = await fetch(`${baseUrl}/api/receipts`, { headers: { cookie: temporarySession } });
  assert.equal(blocked.status, 403);

  const passwordChange = await post("/api/auth/change-password", {
    password: "Alice-new-password-01"
  }, temporarySession);
  assert.equal(passwordChange.status, 200);
  const invalidatedTemporarySession = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: temporarySession }
  });
  assert.equal(invalidatedTemporarySession.status, 401);

  const ownPasswordLogin = await post("/api/auth/login", {
    username: "alice",
    password: "Alice-new-password-01"
  });
  assert.equal(ownPasswordLogin.status, 200);
  const { user: alice } = await json(await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: ownPasswordLogin.headers.get("set-cookie").split(";")[0] }
  }));
  assert.equal(alice.mustChangePassword, false);
});
