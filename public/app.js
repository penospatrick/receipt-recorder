const body = document.body;
const loginScreen = document.querySelector("#login-screen");
const loginForm = document.querySelector("#login-form");
const loginMessage = document.querySelector("#login-message");
const passwordChangeForm = document.querySelector("#password-change-form");
const passwordChangeMessage = document.querySelector("#password-change-message");
const receiptForm = document.querySelector("#receipt-form");
const dateInput = document.querySelector("#receipt-date");
const formMessage = document.querySelector("#form-message");
const receiptList = document.querySelector("#receipt-list");
const countOutput = document.querySelector("#receipt-count");
const totalOutput = document.querySelector("#receipt-total");
const exportPanel = document.querySelector("#export-panel");
const exportMessage = document.querySelector("#export-message");
const adminPanel = document.querySelector("#admin-panel");

const pesoFormatter = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const dateFormatter = new Intl.DateTimeFormat("en-PH", {
  year: "numeric", month: "short", day: "numeric", timeZone: "UTC"
});
const appState = {
  user: null,
  fields: [],
  groups: [],
  users: [],
  permissions: [],
  editingReceiptId: null,
  editingUserId: null,
  editingGroupId: null,
  editingFieldId: null,
  receipts: []
};

function localDateString(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 10);
}

function showMessage(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle("error", isError);
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Something went wrong. Please try again.");
  return body;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 401 && appState.user) {
    setAuthenticated(null);
    showMessage(loginMessage, "Your session has ended. Sign in again.");
    loginForm.elements.username.focus();
  }
  return readJson(response);
}

function userHas(permission) {
  return Boolean(appState.user?.permissions.includes(permission));
}

function setAuthenticated(user) {
  appState.user = user;
  body.classList.toggle("authenticated", Boolean(user));
  document.querySelector("#session-button-label").textContent = user
    ? `${user.displayName} · Sign out`
    : "Sign in";
  document.querySelector("#account-button").title = user
    ? `${user.displayName} · ${user.groupName} (click to sign out)`
    : "Sign in to Zurich Finance Corporation";
  document.querySelector(".dashboard").hidden = !user;
  const hasAdministration = user && ["users:manage", "groups:manage", "fields:manage"].some(userHas);
  adminPanel.hidden = !hasAdministration;
  document.querySelector(".entry-card").hidden = !userHas("receipts:create");
  exportPanel.hidden = !userHas("receipts:export");
  showAdminPanes();
  if (!user) {
    receiptList.replaceChildren();
    countOutput.textContent = "—";
    totalOutput.textContent = "—";
  }
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createCustomControl(field, value = "") {
  let control;
  if (field.type === "select") {
    control = makeElement("select");
    const blankOption = makeElement("option", "", field.required ? "Choose an option…" : "—");
    blankOption.value = "";
    control.append(blankOption);
    for (const optionValue of field.options) {
      const option = makeElement("option", "", optionValue);
      option.value = optionValue;
      control.append(option);
    }
  } else {
    control = makeElement("input");
    control.type = field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
    if (field.type === "number") control.step = "any";
    if (field.type === "text") control.maxLength = 1000;
  }
  control.id = `receipt-custom-${field.id}`;
  control.dataset.customFieldId = String(field.id);
  control.required = field.required;
  control.value = value;
  return control;
}

function renderReceiptFields(values = {}) {
  const container = document.querySelector("#custom-inputs");
  container.replaceChildren();
  for (const field of appState.fields) {
    const wrapper = makeElement("div", "dynamic-field");
    const label = makeElement("label", "", field.label);
    label.htmlFor = `receipt-custom-${field.id}`;
    if (field.required) {
      const required = makeElement("span", "required", " *");
      label.append(required);
    }
    wrapper.append(label, createCustomControl(field, values[String(field.id)] || ""));
    container.append(wrapper);
  }
}

function collectReceiptPayload() {
  const data = new FormData(receiptForm);
  const customValues = {};
  for (const control of receiptForm.querySelectorAll("[data-custom-field-id]")) {
    customValues[control.dataset.customFieldId] = control.value;
  }
  return {
    date: data.get("date"),
    siOrNumber: data.get("siOrNumber"),
    particulars: data.get("particulars"),
    amount: Number(data.get("amount")),
    customValues
  };
}

function renderReceipts(receipts) {
  appState.receipts = receipts;
  countOutput.textContent = receipts.length.toLocaleString("en-PH");
  totalOutput.textContent = pesoFormatter.format(receipts.reduce((sum, receipt) => sum + receipt.amount, 0));
  if (!receipts.length) {
    const empty = makeElement("div", "empty-state");
    empty.append(
      makeElement("strong", "", "No matching receipts."),
      makeElement("span", "", "Try changing the filters or record the first receipt.")
    );
    receiptList.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const receipt of receipts) {
    const item = makeElement("article", "receipt-item");
    const main = makeElement("div", "receipt-main");
    const number = makeElement("div", "receipt-number");
    number.append(
      makeElement("span", "", receipt.siOrNumber),
      makeElement("span", "receipt-date", dateFormatter.format(new Date(`${receipt.date}T00:00:00Z`)))
    );
    const particulars = makeElement("div", "receipt-particulars", receipt.particulars);
    const meta = makeElement("div", "receipt-particulars receipt-owner", `Entered by ${receipt.creatorName || "former user"}`);
    main.append(number, particulars, meta);
    const detail = makeElement("div", "receipt-side");
    detail.append(makeElement("div", "receipt-amount", pesoFormatter.format(receipt.amount)));
    const actions = makeElement("div", "receipt-actions");
    if (receipt.canEdit) {
      const editButton = makeElement("button", "table-action", "Edit");
      editButton.type = "button";
      editButton.addEventListener("click", () => editReceipt(receipt));
      actions.append(editButton);
    }
    if (receipt.canDelete) {
      const deleteButton = makeElement("button", "table-action danger", "Delete");
      deleteButton.type = "button";
      deleteButton.addEventListener("click", () => deleteReceipt(receipt));
      actions.append(deleteButton);
    }
    detail.append(actions);
    item.append(main, detail);
    if (Object.keys(receipt.customValues || {}).length) {
      const custom = makeElement("div", "receipt-custom-preview");
      for (const field of appState.fields) {
        const value = receipt.customValues[String(field.id)];
        if (value) custom.append(makeElement("span", "", `${field.label}: ${value}`));
      }
      if (custom.childElementCount) item.append(custom);
    }
    fragment.append(item);
  }
  receiptList.replaceChildren(fragment);
}

function buildFilterQuery() {
  const params = new URLSearchParams();
  const values = [
    ["from", "#filter-from"], ["to", "#filter-to"],
    ["siOrNumber", "#filter-si-or"], ["particulars", "#filter-particulars"],
    ["amountMin", "#filter-amount-min"], ["amountMax", "#filter-amount-max"],
    ["groupId", "#filter-group"], ["userId", "#filter-user"]
  ];
  for (const [key, selector] of values) {
    const value = document.querySelector(selector).value.trim();
    if (value) params.set(key, value);
  }
  for (const control of document.querySelectorAll("[data-filter-field-id]")) {
    if (control.value) params.set(`cf_${control.dataset.filterFieldId}`, control.value);
  }
  return params;
}

async function loadReceipts(useExportFilters = false) {
  if (!appState.user) return;
  receiptList.replaceChildren(makeElement("div", "loading-state", "Loading your register…"));
  try {
    const params = useExportFilters && userHas("receipts:export") ? buildFilterQuery() : new URLSearchParams();
    const query = params.size ? `?${params}` : "";
    const { receipts } = await api(`/api/receipts${query}`);
    renderReceipts(receipts);
  } catch (error) {
    receiptList.replaceChildren(makeElement("div", "empty-state", error.message));
  }
}

function setReceiptEditing(receipt = null) {
  appState.editingReceiptId = receipt?.id ?? null;
  document.querySelector("#save-button").innerHTML = receipt
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Update receipt'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.5 17 19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Save receipt';
  document.querySelector("#receipt-form-heading").textContent = receipt ? "Edit receipt" : "Record a receipt";
  document.querySelector("#receipt-form-eyebrow").textContent = receipt ? "UPDATE ENTRY" : "NEW ENTRY";
  document.querySelector("#receipt-cancel-edit").hidden = !receipt;
}

function editReceipt(receipt) {
  receiptForm.elements.date.value = receipt.date;
  receiptForm.elements.siOrNumber.value = receipt.siOrNumber;
  receiptForm.elements.particulars.value = receipt.particulars;
  receiptForm.elements.amount.value = receipt.amount.toFixed(2);
  renderReceiptFields(receipt.customValues || {});
  setReceiptEditing(receipt);
  showMessage(formMessage, "Editing your receipt. Save your changes or cancel.");
  document.querySelector("#receipt-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteReceipt(receipt) {
  if (!window.confirm(`Delete receipt ${receipt.siOrNumber}? This cannot be undone.`)) return;
  try {
    await api(`/api/receipts/${receipt.id}`, { method: "DELETE" });
    await loadReceipts(userHas("receipts:export"));
  } catch (error) {
    window.alert(error.message);
  }
}

receiptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#save-button");
  const editingId = appState.editingReceiptId;
  button.disabled = true;
  button.textContent = editingId ? "Updating receipt…" : "Saving receipt…";
  showMessage(formMessage, "");
  try {
    await api(editingId ? `/api/receipts/${editingId}` : "/api/receipts", {
      method: editingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectReceiptPayload())
    });
    receiptForm.reset();
    dateInput.value = localDateString();
    renderReceiptFields();
    setReceiptEditing();
    showMessage(formMessage, editingId ? "Receipt updated." : "Receipt saved to the shared register.");
    await loadReceipts(userHas("receipts:export"));
  } catch (error) {
    showMessage(formMessage, error.message, true);
    if (error.message === "Sign in to continue.") {
      setAuthenticated(null);
    }
  } finally {
    button.disabled = false;
    setReceiptEditing(appState.editingReceiptId ? { id: appState.editingReceiptId } : null);
  }
});

document.querySelector("#receipt-cancel-edit").addEventListener("click", () => {
  receiptForm.reset();
  dateInput.value = localDateString();
  renderReceiptFields();
  setReceiptEditing();
  showMessage(formMessage, "");
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#login-button");
  button.disabled = true;
  showMessage(loginMessage, "");
  try {
    const { user } = await api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: loginForm.elements.username.value,
        password: loginForm.elements.password.value
      })
    });
    loginForm.reset();
    if (user.mustChangePassword) {
      loginForm.hidden = true;
      passwordChangeForm.hidden = false;
      document.querySelector("#login-title").textContent = "Create your new password";
      document.querySelector(".login-copy").textContent = "Your administrator gave you a temporary password. Set a new password to continue.";
      document.querySelector("#first-password").focus();
      return;
    }
    await openWorkspace(user);
  } catch (error) {
    showMessage(loginMessage, error.message, true);
  } finally {
    button.disabled = false;
  }
});

async function signOut() {
  try {
    await api("/api/auth/logout", { method: "POST" });
    setAuthenticated(null);
    loginForm.elements.username.focus();
    showMessage(loginMessage, "You have been signed out.");
  } catch (error) {
    window.alert(error.message);
  }
}

document.querySelector("#account-button").addEventListener("click", () => {
  if (appState.user) signOut();
  else loginForm.elements.username.focus();
});

function fillSelect(select, options, blankLabel) {
  select.replaceChildren();
  if (blankLabel) {
    const blank = makeElement("option", "", blankLabel);
    blank.value = "";
    select.append(blank);
  }
  for (const item of options) {
    const option = makeElement("option", "", item.label);
    option.value = String(item.value);
    select.append(option);
  }
}

function renderExportFilters() {
  const groupOptions = appState.groups.map((group) => ({ label: group.name, value: group.id }));
  const userOptions = appState.users.filter((user) => user.active)
    .map((user) => ({ label: `${user.displayName} (${user.username})`, value: user.id }));
  fillSelect(document.querySelector("#filter-group"), groupOptions, "All groups");
  fillSelect(document.querySelector("#filter-user"), userOptions, "All users");
  document.querySelector("#filter-group-wrap").hidden = !userHas("receipts:read_all");
  document.querySelector("#filter-user-wrap").hidden = !userHas("receipts:read_all");
  const container = document.querySelector("#custom-filters");
  container.replaceChildren();
  for (const field of appState.fields) {
    const wrapper = makeElement("div");
    const label = makeElement("label", "", `${field.label} contains`);
    label.htmlFor = `filter-field-${field.id}`;
    const control = createCustomControl({ ...field, required: false });
    control.id = `filter-field-${field.id}`;
    control.dataset.filterFieldId = String(field.id);
    control.removeAttribute("data-custom-field-id");
    control.required = false;
    if (control.tagName === "SELECT") {
      control.options[0].textContent = "Any value";
    } else if (control.type !== "date") {
      control.placeholder = "Any value";
    }
    wrapper.append(label, control);
    container.append(wrapper);
  }
}

async function loadWorkspaceData() {
  const { fields } = await api("/api/fields");
  appState.fields = fields;
  renderReceiptFields();
  await loadReceipts();

  const groupsResponse = await api("/api/groups");
  appState.groups = groupsResponse.groups;
  fillSelect(
    document.querySelector("#user-group"),
    appState.groups.map((group) => ({ label: group.name, value: group.id }))
  );
  if (userHas("receipts:read_all") && userHas("receipts:export")) {
    const usersResponse = await api("/api/users/directory");
    appState.users = usersResponse.users;
  } else {
    appState.users = [];
  }
  renderExportFilters();

  const adminRequests = [];
  if (userHas("users:manage")) adminRequests.push(loadUsers());
  if (userHas("groups:manage")) adminRequests.push(loadGroups());
  if (userHas("fields:manage")) adminRequests.push(loadAdminFields());
  await Promise.all(adminRequests);
}

async function openWorkspace(user) {
  setAuthenticated(user);
  dateInput.value = localDateString();
  await loadWorkspaceData();
}

async function restoreSession() {
  try {
    const { user } = await api("/api/auth/me");
    if (user.mustChangePassword) {
      loginForm.hidden = true;
      passwordChangeForm.hidden = false;
      document.querySelector("#login-title").textContent = "Create your new password";
      document.querySelector(".login-copy").textContent = "Your administrator gave you a temporary password. Set a new password to continue.";
      return;
    }
    await openWorkspace(user);
  } catch (error) {
    if (error.message !== "Sign in to continue.") showMessage(loginMessage, error.message, true);
    setAuthenticated(null);
  }
}

document.querySelector("#export-button").addEventListener("click", async () => {
  const params = buildFilterQuery();
  const button = document.querySelector("#export-button");
  button.disabled = true;
  showMessage(exportMessage, "");
  try {
    const response = await fetch(`/api/receipts/export.xlsx${params.size ? `?${params}` : ""}`);
    if (!response.ok) throw new Error((await response.json()).error || "Excel export failed.");
    const url = URL.createObjectURL(await response.blob());
    const link = makeElement("a");
    link.href = url;
    link.download = `receipts-${localDateString()}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showMessage(exportMessage, "Filtered Excel workbook downloaded.");
  } catch (error) {
    showMessage(exportMessage, error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#clear-filters").addEventListener("click", async () => {
  document.querySelector("#export-filter-form").reset();
  await loadReceipts(false);
  showMessage(exportMessage, "Filters cleared.");
});

document.querySelector("#preview-filters").addEventListener("click", async () => {
  await loadReceipts(true);
  if (!document.querySelector("#receipt-list .empty-state")) {
    showMessage(exportMessage, `${countOutput.textContent} matching receipt(s) previewed above.`);
  }
});

document.querySelector("#refresh-button").addEventListener("click", () => loadReceipts(userHas("receipts:export")));

function showAdminPanes() {
  if (!appState.user) return;
  const visibleTabs = [];
  if (userHas("users:manage")) visibleTabs.push("users");
  if (userHas("groups:manage")) visibleTabs.push("groups");
  if (userHas("fields:manage")) visibleTabs.push("fields");
  for (const button of document.querySelectorAll(".admin-tab")) {
    button.hidden = !visibleTabs.includes(button.dataset.adminTab);
  }
  const activeTab = visibleTabs.includes(document.querySelector(".admin-tab.active")?.dataset.adminTab)
    ? document.querySelector(".admin-tab.active").dataset.adminTab
    : visibleTabs[0];
  for (const button of document.querySelectorAll(".admin-tab")) {
    button.classList.toggle("active", button.dataset.adminTab === activeTab);
  }
  for (const pane of document.querySelectorAll(".admin-pane")) {
    pane.hidden = pane.id !== `admin-${activeTab}-pane`;
  }
}

document.querySelectorAll(".admin-tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    document.querySelectorAll(".admin-pane").forEach((pane) => {
      pane.hidden = pane.id !== `admin-${button.dataset.adminTab}-pane`;
    });
  });
});

async function loadUsers() {
  const { users } = await api("/api/admin/users");
  appState.users = users;
  const bodyElement = document.querySelector("#users-table-body");
  bodyElement.replaceChildren();
  for (const user of users) {
    const row = document.createElement("tr");
    row.append(
      makeElement("td", "", user.displayName),
      makeElement("td", "", user.username),
      makeElement("td", "", user.groupName)
    );
    const statusCell = makeElement("td");
    statusCell.append(makeElement("span", `status-badge${user.active ? "" : " inactive"}`, user.active ? "Active" : "Disabled"));
    row.append(statusCell);
    const actionCell = makeElement("td");
    const edit = makeElement("button", "table-action", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => beginEditUser(user));
    actionCell.append(edit);
    if (user.id !== appState.user.id) {
      const toggle = makeElement("button", `table-action${user.active ? " danger" : ""}`, user.active ? "Disable" : "Enable");
      toggle.type = "button";
      toggle.addEventListener("click", () => toggleUser(user));
      actionCell.append(toggle);
      const remove = makeElement("button", "table-action danger", "Delete");
      remove.type = "button";
      remove.addEventListener("click", () => deleteUser(user));
      actionCell.append(remove);
    }
    row.append(actionCell);
    bodyElement.append(row);
  }
}

async function loadGroups() {
  const [groupsResponse, permissionResponse] = await Promise.all([
    api("/api/groups"),
    api("/api/admin/permissions")
  ]);
  appState.groups = groupsResponse.groups;
  appState.permissions = permissionResponse.permissions;
  const selector = document.querySelector("#user-group");
  const current = selector.value;
  fillSelect(selector, appState.groups.map((group) => ({ label: group.name, value: group.id })));
  if (current) selector.value = current;
  renderExportFilters();
  renderPermissionOptions();
  renderGroups();
}

function renderGroups() {
  const list = document.querySelector("#groups-list");
  list.replaceChildren();
  for (const group of appState.groups) {
    const card = makeElement("div", "group-card");
    card.append(
      makeElement("strong", "", group.name),
      makeElement("span", "", `${group.userCount} active user${group.userCount === 1 ? "" : "s"} · ${group.permissions.length} permissions`)
    );
    const edit = makeElement("button", "table-action", "Edit permissions");
    edit.type = "button";
    edit.addEventListener("click", () => beginEditGroup(group));
    card.append(edit);
    if (!group.isSystem) {
      const remove = makeElement("button", "table-action danger", "Delete");
      remove.type = "button";
      remove.addEventListener("click", () => deleteGroup(group));
      card.append(remove);
    }
    list.append(card);
  }
}

function renderPermissionOptions(selected = []) {
  const list = document.querySelector("#permission-list");
  list.replaceChildren();
  for (const permission of appState.permissions) {
    const label = makeElement("label", "permission-option");
    const checkbox = makeElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "permissions";
    checkbox.value = permission.key;
    checkbox.checked = selected.includes(permission.key);
    label.append(checkbox, document.createTextNode(permission.label));
    list.append(label);
  }
}

function groupPayload() {
  return {
    name: document.querySelector("#group-name").value,
    description: document.querySelector("#group-description").value,
    permissions: [...document.querySelectorAll("#permission-list input:checked")].map((input) => input.value)
  };
}

function resetGroupForm() {
  appState.editingGroupId = null;
  document.querySelector("#group-form").reset();
  document.querySelector("#group-edit-id").value = "";
  document.querySelector("#group-submit").textContent = "Create group";
  document.querySelector("#group-cancel").hidden = true;
  document.querySelector("#group-delete").hidden = true;
  renderPermissionOptions();
  showMessage(document.querySelector("#group-message"), "");
}

function beginEditGroup(group) {
  appState.editingGroupId = group.id;
  document.querySelector("#group-edit-id").value = String(group.id);
  document.querySelector("#group-name").value = group.name;
  document.querySelector("#group-description").value = group.description;
  document.querySelector("#group-submit").textContent = "Save group";
  document.querySelector("#group-cancel").hidden = false;
  document.querySelector("#group-delete").hidden = group.isSystem;
  renderPermissionOptions(group.permissions);
  showMessage(document.querySelector("#group-message"), group.isSystem ? "Default group: edit its permissions, but it cannot be deleted." : "");
}

document.querySelector("#group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const editingId = appState.editingGroupId;
  try {
    await api(editingId ? `/api/admin/groups/${editingId}` : "/api/admin/groups", {
      method: editingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupPayload())
    });
    await loadGroups();
    resetGroupForm();
    showMessage(document.querySelector("#group-message"), editingId ? "Group updated." : "Group created.");
    if (editingId && appState.user.groupId === editingId) {
      const { user } = await api("/api/auth/me");
      await openWorkspace(user);
    }
  } catch (error) {
    showMessage(document.querySelector("#group-message"), error.message, true);
  }
});
document.querySelector("#group-cancel").addEventListener("click", resetGroupForm);
document.querySelector("#group-delete").addEventListener("click", async () => {
  const groupId = appState.editingGroupId;
  const group = appState.groups.find((item) => item.id === groupId);
  if (!group || !window.confirm(`Delete the "${group.name}" group?`)) return;
  try {
    await api(`/api/admin/groups/${groupId}`, { method: "DELETE" });
    await loadGroups();
    resetGroupForm();
  } catch (error) {
    showMessage(document.querySelector("#group-message"), error.message, true);
  }
});

function beginEditUser(user) {
  appState.editingUserId = user.id;
  document.querySelector("#user-edit-id").value = String(user.id);
  document.querySelector("#user-display-name").value = user.displayName;
  document.querySelector("#user-username").value = user.username;
  document.querySelector("#user-group").value = String(user.groupId);
  const password = document.querySelector("#user-password");
  password.value = "";
  password.required = false;
  password.placeholder = "Leave blank to keep current password; a reset requires a new password";
  document.querySelector("#user-password-label").textContent = "Reset password";
  document.querySelector("#user-submit").textContent = "Save changes";
  document.querySelector("#user-cancel").hidden = false;
  showMessage(document.querySelector("#user-message"), `Editing ${user.displayName}.`);
}

function resetUserForm() {
  appState.editingUserId = null;
  document.querySelector("#user-form").reset();
  document.querySelector("#user-edit-id").value = "";
  const password = document.querySelector("#user-password");
  password.required = true;
  password.placeholder = "At least 10 characters";
  document.querySelector("#user-password-label").textContent = "Password";
  document.querySelector("#user-submit").textContent = "Create user";
  document.querySelector("#user-cancel").hidden = true;
  showMessage(document.querySelector("#user-message"), "");
}

passwordChangeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = passwordChangeForm.elements.password.value;
  const confirmation = passwordChangeForm.elements.confirmPassword.value;
  if (password !== confirmation) {
    showMessage(passwordChangeMessage, "The passwords do not match.", true);
    return;
  }
  const button = document.querySelector("#first-password-submit");
  button.disabled = true;
  showMessage(passwordChangeMessage, "");
  try {
    const { username } = await api("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    passwordChangeForm.reset();
    passwordChangeForm.hidden = true;
    loginForm.hidden = false;
    document.querySelector("#login-title").textContent = "Sign in to your workspace";
    document.querySelector(".login-copy").textContent = "Enter the username and password provided by your system administrator.";
    loginForm.elements.username.value = username;
    loginForm.elements.password.focus();
    showMessage(loginMessage, "Your password has been updated. Sign in with your new password.");
  } catch (error) {
    showMessage(passwordChangeMessage, error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#first-password-signout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    passwordChangeForm.reset();
    passwordChangeForm.hidden = true;
    loginForm.hidden = false;
    document.querySelector("#login-title").textContent = "Sign in to your workspace";
    document.querySelector(".login-copy").textContent = "Enter the username and password provided by your system administrator.";
    loginForm.elements.username.focus();
    showMessage(passwordChangeMessage, "");
  } catch (error) {
    showMessage(passwordChangeMessage, error.message, true);
  }
});

document.querySelector("#user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const editingId = appState.editingUserId;
  const payload = {
    displayName: document.querySelector("#user-display-name").value,
    username: document.querySelector("#user-username").value,
    groupId: Number(document.querySelector("#user-group").value),
    password: document.querySelector("#user-password").value
  };
  try {
    const result = await api(editingId ? `/api/admin/users/${editingId}` : "/api/admin/users", {
      method: editingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (result.signedOut) {
      resetUserForm();
      setAuthenticated(null);
      loginForm.elements.username.value = payload.username;
      showMessage(loginMessage, "Your password was reset. Sign in with the temporary password, then set your own password.");
      return;
    }
    resetUserForm();
    await loadUsers();
    if (userHas("receipts:read_all") && userHas("receipts:export")) renderExportFilters();
    const message = editingId && payload.password
      ? "Password reset. The user must set a new password at next sign-in; all existing sessions were signed out."
      : editingId ? "User updated." : "User account created.";
    showMessage(document.querySelector("#user-message"), message);
  } catch (error) {
    showMessage(document.querySelector("#user-message"), error.message, true);
  }
});
document.querySelector("#user-cancel").addEventListener("click", resetUserForm);

document.querySelector("#user-template-download").addEventListener("click", async () => {
  const button = document.querySelector("#user-template-download");
  button.disabled = true;
  showMessage(document.querySelector("#bulk-user-message"), "");
  try {
    const response = await fetch("/api/admin/users/template.xlsx");
    if (!response.ok) throw new Error((await response.json()).error || "Could not download the template.");
    const url = URL.createObjectURL(await response.blob());
    const link = makeElement("a");
    link.href = url;
    link.download = "user-upload-template.xlsx";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    showMessage(document.querySelector("#bulk-user-message"), error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#bulk-user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const fileInput = document.querySelector("#bulk-user-file");
  const file = fileInput.files[0];
  if (!file) return;
  const button = document.querySelector("#bulk-user-submit");
  const message = document.querySelector("#bulk-user-message");
  const resultsTable = document.querySelector("#bulk-user-results");
  button.disabled = true;
  resultsTable.hidden = true;
  resultsTable.querySelector("tbody").replaceChildren();
  showMessage(message, "Uploading and validating users…");
  try {
    const response = await fetch("/api/admin/users/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      body: file
    });
    const result = await readJson(response);
    showMessage(message, `Created ${result.created} user(s); skipped ${result.skipped} row(s). Temporary passwords are not retained.`);
    const tbody = resultsTable.querySelector("tbody");
    for (const row of result.results) {
      const tr = makeElement("tr");
      for (const value of [row.row, row.username, row.status, row.message]) {
        tr.append(makeElement("td", "", String(value)));
      }
      tbody.append(tr);
    }
    resultsTable.hidden = false;
    fileInput.value = "";
    await loadUsers();
    if (userHas("receipts:read_all") && userHas("receipts:export")) {
      const usersResponse = await api("/api/users/directory");
      appState.users = usersResponse.users;
      renderExportFilters();
    }
  } catch (error) {
    showMessage(message, error.message, true);
  } finally {
    button.disabled = false;
  }
});

async function toggleUser(user) {
  if (user.active && !window.confirm(`Disable ${user.displayName}'s account? They will be signed out.`)) return;
  try {
    await api(`/api/admin/users/${user.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: user.displayName,
        username: user.username,
        groupId: user.groupId,
        active: !user.active
      })
    });
    await loadUsers();
    if (userHas("receipts:read_all") && userHas("receipts:export")) renderExportFilters();
    showMessage(
      document.querySelector("#user-message"),
      `Account ${user.active ? "disabled" : "enabled"}; existing sessions were signed out.`
    );
  } catch (error) {
    showMessage(document.querySelector("#user-message"), error.message, true);
  }
}

async function deleteUser(user) {
  if (!window.confirm(`Permanently delete ${user.displayName}'s account? Their receipt records will be retained and attributed to a former user.`)) return;
  try {
    await api(`/api/admin/users/${user.id}`, { method: "DELETE" });
    await loadUsers();
    if (userHas("receipts:read_all") && userHas("receipts:export")) {
      const usersResponse = await api("/api/users/directory");
      appState.users = usersResponse.users;
      renderExportFilters();
    }
  } catch (error) {
    showMessage(document.querySelector("#user-message"), error.message, true);
  }
}

async function loadAdminFields() {
  const { fields } = await api("/api/admin/fields");
  const bodyElement = document.querySelector("#fields-table-body");
  bodyElement.replaceChildren();
  for (const field of fields) {
    const row = makeElement("tr", field.active ? "" : "field-row-archived");
    row.append(
      makeElement("td", "", field.label),
      makeElement("td", "", field.type === "select" ? `Dropdown (${field.options.length})` : field.type),
      makeElement("td", "", field.required ? "Yes" : "No")
    );
    const statusCell = makeElement("td");
    statusCell.append(makeElement("span", `status-badge${field.active ? "" : " inactive"}`, field.active ? "Active" : "Archived"));
    row.append(statusCell);
    const actionCell = makeElement("td");
    if (field.active) {
      const edit = makeElement("button", "table-action", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => beginEditField(field));
      const archive = makeElement("button", "table-action danger", "Archive");
      archive.type = "button";
      archive.addEventListener("click", () => archiveField(field));
      actionCell.append(edit, archive);
    } else {
      actionCell.textContent = "Values retained in receipt history";
    }
    row.append(actionCell);
    bodyElement.append(row);
  }
}

function updateFieldOptionsVisibility() {
  document.querySelector("#field-options-wrap").hidden = document.querySelector("#field-type").value !== "select";
}
document.querySelector("#field-type").addEventListener("change", updateFieldOptionsVisibility);

function resetFieldForm() {
  appState.editingFieldId = null;
  document.querySelector("#field-form").reset();
  document.querySelector("#field-edit-id").value = "";
  document.querySelector("#field-submit").textContent = "Add field";
  document.querySelector("#field-cancel").hidden = true;
  updateFieldOptionsVisibility();
  showMessage(document.querySelector("#field-message"), "");
}

function beginEditField(field) {
  appState.editingFieldId = field.id;
  document.querySelector("#field-edit-id").value = String(field.id);
  document.querySelector("#field-label").value = field.label;
  document.querySelector("#field-type").value = field.type;
  document.querySelector("#field-required").checked = field.required;
  document.querySelector("#field-options").value = field.options.join("\n");
  document.querySelector("#field-submit").textContent = "Save field";
  document.querySelector("#field-cancel").hidden = false;
  updateFieldOptionsVisibility();
  showMessage(document.querySelector("#field-message"), `Editing "${field.label}".`);
}

document.querySelector("#field-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const editingId = appState.editingFieldId;
  const payload = {
    label: document.querySelector("#field-label").value,
    type: document.querySelector("#field-type").value,
    required: document.querySelector("#field-required").checked,
    options: document.querySelector("#field-options").value.split("\n").map((option) => option.trim()).filter(Boolean)
  };
  try {
    await api(editingId ? `/api/admin/fields/${editingId}` : "/api/admin/fields", {
      method: editingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    resetFieldForm();
    const { fields } = await api("/api/fields");
    appState.fields = fields;
    renderReceiptFields();
    renderExportFilters();
    await loadAdminFields();
    showMessage(document.querySelector("#field-message"), editingId ? "Field updated." : "Custom receipt field added.");
  } catch (error) {
    showMessage(document.querySelector("#field-message"), error.message, true);
  }
});
document.querySelector("#field-cancel").addEventListener("click", resetFieldForm);

async function archiveField(field) {
  if (!window.confirm(`Archive "${field.label}"? Existing receipt values will be kept in Excel exports.`)) return;
  try {
    await api(`/api/admin/fields/${field.id}`, { method: "DELETE" });
    const { fields } = await api("/api/fields");
    appState.fields = fields;
    renderReceiptFields();
    renderExportFilters();
    await loadAdminFields();
  } catch (error) {
    showMessage(document.querySelector("#field-message"), error.message, true);
  }
}

dateInput.value = localDateString();
restoreSession();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((error) => {
      console.error("Could not register offline app shell:", error);
    });
  });
}
