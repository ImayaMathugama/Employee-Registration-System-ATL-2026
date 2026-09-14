const els = {
  supabaseUrl: document.getElementById("supabaseUrl"),
  supabaseAnonKey: document.getElementById("supabaseAnonKey"),
  stationId: document.getElementById("stationId"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  syncStatus: document.getElementById("syncStatus"),
  masterCsvInput: document.getElementById("masterCsvInput"),
  exportBtn: document.getElementById("exportBtn"),
  masterInfo: document.getElementById("masterInfo"),
  scanForm: document.getElementById("scanForm"),
  barcodeInput: document.getElementById("barcodeInput"),
  recordsBody: document.getElementById("recordsBody"),
  totalScans: document.getElementById("totalScans"),
  uniqueCount: document.getElementById("uniqueCount"),
  duplicateCount: document.getElementById("duplicateCount"),
  maleCount: document.getElementById("maleCount"),
  femaleCount: document.getElementById("femaleCount"),
  inactiveCount: document.getElementById("inactiveCount"),
  mismatchCount: document.getElementById("mismatchCount"),
};

const storageKeys = {
  config: "employee-reg-config",
  masterRows: "employee-reg-master-rows",
};

const state = {
  supabase: null,
  subscription: null,
  useCloud: false,
  records: [],
  masterMap: new Map(),
  registeredSet: new Set(),
  registrationChart: null,
  genderChart: null,
};

init();

function init() {
  loadSavedConfig();
  loadSavedMaster();
  buildCharts();
  bindEvents();
  render();
}

function bindEvents() {
  els.scanForm.addEventListener("submit", onScanSubmit);
  els.masterCsvInput.addEventListener("change", onMasterCsvUpload);
  els.exportBtn.addEventListener("click", exportRecordsAsCsv);
  els.connectBtn.addEventListener("click", connectCloud);
  els.disconnectBtn.addEventListener("click", useLocalMode);
}

function loadSavedConfig() {
  const raw = localStorage.getItem(storageKeys.config);
  if (!raw) {
    els.stationId.value = `Station-${Math.floor(Math.random() * 90 + 10)}`;
    return;
  }

  try {
    const cfg = JSON.parse(raw);
    els.supabaseUrl.value = cfg.url || "";
    els.supabaseAnonKey.value = cfg.anonKey || "";
    els.stationId.value = cfg.stationId || "";
  } catch {
    els.stationId.value = `Station-${Math.floor(Math.random() * 90 + 10)}`;
  }
}

function loadSavedMaster() {
  const raw = localStorage.getItem(storageKeys.masterRows);
  if (!raw) return;
  try {
    const rows = JSON.parse(raw);
    setMasterRows(rows);
  } catch {
    localStorage.removeItem(storageKeys.masterRows);
  }
}

async function connectCloud() {
  const url = els.supabaseUrl.value.trim();
  const anonKey = els.supabaseAnonKey.value.trim();
  const stationId = els.stationId.value.trim() || "Station-Unknown";

  if (!url || !anonKey) {
    alert("Please provide Supabase URL and Anon Key.");
    return;
  }

  try {
    state.supabase = window.supabase.createClient(url, anonKey);
    state.useCloud = true;
    localStorage.setItem(storageKeys.config, JSON.stringify({ url, anonKey, stationId }));
    setSyncStatus("Connected", true);
    await reloadFromCloud();
    subscribeRealtime();
  } catch (err) {
    console.error(err);
    setSyncStatus("Connection Failed", false);
    alert("Failed to connect Supabase. Please verify details.");
  }
}

function useLocalMode() {
  state.useCloud = false;
  state.supabase = null;
  state.registeredSet = new Set();
  if (state.subscription) {
    state.subscription.unsubscribe();
    state.subscription = null;
  }
  setSyncStatus("Local Mode", false);
  rebuildRegisteredSetFromRecords();
  render();
}

async function reloadFromCloud() {
  const { data, error } = await state.supabase
    .from("scan_events")
    .select("id, emp_no, emp_name, gender, status, event_type, station_id, scanned_at")
    .order("scanned_at", { ascending: false })
    .limit(500);

  if (error) {
    throw error;
  }

  state.records = (data || []).map(normalizeCloudRecord);
  rebuildRegisteredSetFromRecords();
  render();
}

function subscribeRealtime() {
  if (state.subscription) {
    state.subscription.unsubscribe();
  }

  state.subscription = state.supabase
    .channel("scan-events-feed")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "scan_events" },
      (payload) => {
        const record = normalizeCloudRecord(payload.new);
        const exists = state.records.some((x) => x.id === record.id);
        if (exists) return;
        state.records.unshift(record);
        if (record.eventType !== "duplicate") {
          state.registeredSet.add(record.empNo);
        }
        render();
      }
    )
    .subscribe();
}

function normalizeCloudRecord(row) {
  return {
    id: row.id,
    time: row.scanned_at,
    stationId: row.station_id || "Unknown",
    empNo: String(row.emp_no || ""),
    name: row.emp_name || "Unknown",
    gender: normalizeGender(row.gender),
    status: normalizeStatus(row.status),
    eventType: row.event_type || "registered",
  };
}

function onMasterCsvUpload(event) {
  const [file] = event.target.files || [];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    const rows = parseCsv(text);
    if (!rows.length) {
      alert("No data rows found in CSV.");
      return;
    }

    setMasterRows(rows);
    localStorage.setItem(storageKeys.masterRows, JSON.stringify(rows));
    render();
  };

  reader.readAsText(file);
}

function setMasterRows(rows) {
  state.masterMap.clear();
  rows.forEach((row) => {
    const empNo = String(row.EMP_NO || row.emp_no || "").trim();
    if (!empNo) return;

    const name = String(row.EMP_NAME || row.emp_name || row.NAME || "").trim();
    const gender = normalizeGender(row.Gender || row.gender || "Unknown");
    const statusRaw = String(row.Status || row.status || "Active").trim();
    const inactive = ["inactive", "disabled", "terminated", "retired"].includes(
      statusRaw.toLowerCase()
    );

    state.masterMap.set(empNo, {
      empNo,
      name: name || "Unknown",
      gender,
      statusRaw,
      inactive,
    });
  });

  els.masterInfo.textContent = `Master CSV loaded: ${state.masterMap.size} employees`;
}

function parseCsv(csvText) {
  const lines = csvText.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (cols[i] || "").trim();
    });
    return obj;
  });
}

function splitCsvLine(line) {
  const cols = [];
  let cur = "";
  let quote = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (quote && next === '"') {
        cur += '"';
        i += 1;
      } else {
        quote = !quote;
      }
    } else if (ch === "," && !quote) {
      cols.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }

  cols.push(cur);
  return cols;
}

async function onScanSubmit(event) {
  event.preventDefault();
  const empNo = els.barcodeInput.value.trim();
  if (!empNo) return;

  els.barcodeInput.value = "";
  const stationId = (els.stationId.value || "Station-Unknown").trim();
  const now = new Date().toISOString();
  const master = state.masterMap.get(empNo);

  let status = "registered";
  if (!master) {
    status = "mismatch";
  } else if (master.inactive) {
    status = "inactive";
  }

  const payload = {
    empNo,
    name: master?.name || "Unknown",
    gender: master?.gender || "Unknown",
    status,
    stationId,
    time: now,
  };

  if (state.useCloud && state.supabase) {
    await registerCloud(payload);
  } else {
    registerLocal(payload);
  }

  els.barcodeInput.focus();
}

async function registerCloud(payload) {
  let eventType = "registered";

  const { error: insertError } = await state.supabase.from("registrations").insert({
    emp_no: payload.empNo,
    emp_name: payload.name,
    gender: payload.gender,
    master_status: payload.status,
    first_scanned_at: payload.time,
    station_id: payload.stationId,
  });

  if (insertError && String(insertError.code) === "23505") {
    eventType = "duplicate";
  } else if (insertError) {
    alert(`Cloud write failed: ${insertError.message}`);
    return;
  }

  const eventStatus = eventType === "duplicate" ? "duplicate" : payload.status;
  const { error: eventError } = await state.supabase.from("scan_events").insert({
    emp_no: payload.empNo,
    emp_name: payload.name,
    gender: payload.gender,
    status: eventStatus,
    event_type: eventType,
    station_id: payload.stationId,
    scanned_at: payload.time,
  });

  if (eventError) {
    alert(`Cloud event write failed: ${eventError.message}`);
    return;
  }
}

function registerLocal(payload) {
  const duplicate = state.registeredSet.has(payload.empNo);
  const eventType = duplicate ? "duplicate" : "registered";
  const status = duplicate ? "duplicate" : payload.status;

  if (!duplicate) {
    state.registeredSet.add(payload.empNo);
  }

  state.records.unshift({
    id: `${Date.now()}-${Math.random()}`,
    time: payload.time,
    stationId: payload.stationId,
    empNo: payload.empNo,
    name: payload.name,
    gender: payload.gender,
    status,
    eventType,
  });

  render();
}

function rebuildRegisteredSetFromRecords() {
  state.registeredSet.clear();
  state.records.forEach((record) => {
    if (record.eventType !== "duplicate") {
      state.registeredSet.add(record.empNo);
    }
  });
}

function getSummary() {
  const summary = {
    total: state.records.length,
    unique: state.registeredSet.size,
    duplicates: 0,
    male: 0,
    female: 0,
    inactive: 0,
    mismatch: 0,
  };

  state.records.forEach((record) => {
    if (record.eventType === "duplicate") summary.duplicates += 1;
    if (record.gender === "Male") summary.male += 1;
    if (record.gender === "Female") summary.female += 1;
    if (record.status === "inactive") summary.inactive += 1;
    if (record.status === "mismatch") summary.mismatch += 1;
  });

  return summary;
}

function render() {
  renderTable();
  renderStats();
  renderCharts();
}

function renderTable() {
  els.recordsBody.innerHTML = "";
  state.records.slice(0, 500).forEach((record, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${formatTime(record.time)}</td>
      <td>${escapeHtml(record.stationId)}</td>
      <td>${escapeHtml(record.empNo)}</td>
      <td>${escapeHtml(record.name)}</td>
      <td>${escapeHtml(record.gender)}</td>
      <td>${statusBadge(record.status)}</td>
      <td>${statusBadge(record.eventType)}</td>
    `;
    els.recordsBody.appendChild(tr);
  });
}

function renderStats() {
  const s = getSummary();
  els.totalScans.textContent = s.total;
  els.uniqueCount.textContent = s.unique;
  els.duplicateCount.textContent = s.duplicates;
  els.maleCount.textContent = s.male;
  els.femaleCount.textContent = s.female;
  els.inactiveCount.textContent = s.inactive;
  els.mismatchCount.textContent = s.mismatch;
}

function buildCharts() {
  const regCtx = document.getElementById("registrationChart");
  const genderCtx = document.getElementById("genderChart");

  state.registrationChart = new Chart(regCtx, {
    type: "bar",
    data: {
      labels: ["Total", "Registered", "Duplicates", "Inactive", "Mismatch"],
      datasets: [{
        label: "Scan Summary",
        data: [0, 0, 0, 0, 0],
        backgroundColor: ["#22d3ee", "#22c55e", "#f97316", "#64748b", "#ef4444"],
      }],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });

  state.genderChart = new Chart(genderCtx, {
    type: "doughnut",
    data: {
      labels: ["Male", "Female", "Other/Unknown"],
      datasets: [{
        data: [0, 0, 0],
        backgroundColor: ["#3b82f6", "#ec4899", "#f59e0b"],
      }],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

function renderCharts() {
  const s = getSummary();
  const unknown = Math.max(s.total - (s.male + s.female), 0);

  state.registrationChart.data.datasets[0].data = [
    s.total,
    s.unique,
    s.duplicates,
    s.inactive,
    s.mismatch,
  ];
  state.registrationChart.update();

  state.genderChart.data.datasets[0].data = [s.male, s.female, unknown];
  state.genderChart.update();
}

function exportRecordsAsCsv() {
  if (!state.records.length) {
    alert("No records to export.");
    return;
  }

  const rows = [
    ["Time", "Station", "Employee No", "Name", "Gender", "Status", "Event"],
    ...state.records.map((r) => [
      formatTime(r.time),
      r.stationId,
      r.empNo,
      r.name,
      r.gender,
      r.status,
      r.eventType,
    ]),
  ];

  const csv = rows
    .map((line) => line.map((col) => `"${String(col).replaceAll('"', '""')}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `employee_registration_records_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function setSyncStatus(text, connected) {
  els.syncStatus.textContent = text;
  els.syncStatus.className = `status-pill ${connected ? "good" : "warning"}`;
}

function normalizeGender(v) {
  const value = String(v || "").trim().toLowerCase();
  if (value.startsWith("m")) return "Male";
  if (value.startsWith("f")) return "Female";
  return "Unknown";
}

function normalizeStatus(v) {
  const value = String(v || "").trim().toLowerCase();
  if (["inactive", "disabled", "terminated", "retired"].includes(value)) return "inactive";
  if (value === "mismatch") return "mismatch";
  if (value === "duplicate") return "duplicate";
  return "registered";
}

function statusBadge(value) {
  const cls = normalizeStatus(value);
  const label = String(value || "registered").replace(/^./, (c) => c.toUpperCase());
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
