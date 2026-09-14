const SAMPLE_MASTER = [
  ["81017", "J.K. Ranasinghe", "Male"],
  ["60033", "G.C. G.C.Fernando", "Male"],
  ["100012", "M.A.S.R.R. Perera", "Male"],
  ["100013", "K.P.G.U. K.P.G. Udaya Kumara", "Female"],
  ["100017", "K.P.G.C. Kumari", "Female"],
  ["100023", "H.M.K. H.M.K. Damayanthi", "Female"],
  ["23986", "W.N.R  Fernando", "Female"],
  ["70212", "W.D.H. De Silva", "Female"],
  ["27229", "K.A.N.T.N. Chandrarathna", "Male"],
  ["70266", "J.M.S. Koralage", "Male"],
  ["27684", "K.G.S.R.M. Manoj", "Male"],
  ["27775", "P.I.U. Pathirana", "Male"],
  ["28047", "M.H.K. Susantha", "Male"],
  ["28084", "M.S.N. Fernando", "Male"],
  ["28180", "A.M.P.H.S. Perera", "Male"],
  ["28187", "W.P.G. Kalani", "Female"]
];

const state = {
  stationName: localStorage.getItem("stationName") || `Station-${String(Math.floor(Math.random() * 90) + 10)}`,
  master: new Map(),
  events: [],
  eventIds: new Set(),
  registeredSet: new Set(),
  supabase: null,
  subscription: null
};

const el = {
  stationName: document.getElementById("stationName"),
  masterCsv: document.getElementById("masterCsv"),
  supabaseUrl: document.getElementById("supabaseUrl"),
  supabaseKey: document.getElementById("supabaseKey"),
  connectRealtime: document.getElementById("connectRealtime"),
  status: document.getElementById("status"),
  scanInput: document.getElementById("scanInput"),
  stats: document.getElementById("stats"),
  scanTableBody: document.getElementById("scanTableBody"),
  inactiveTableBody: document.getElementById("inactiveTableBody")
};

function bootstrapMaster() {
  SAMPLE_MASTER.forEach(([empNo, name, gender]) => {
    state.master.set(empNo, { empNo, name, gender });
  });
}

function parseCsv(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(",").map((v) => v.trim()));
}

function loadMasterFromRows(rows) {
  const header = rows[0] || [];
  const idxNo = header.findIndex((h) => h.toUpperCase() === "EMP_NO");
  const idxName = header.findIndex((h) => h.toUpperCase() === "EMP_NAME");
  const idxGender = header.findIndex((h) => h.toUpperCase() === "GENDER");

  const useHeader = idxNo >= 0 && idxName >= 0;
  const source = useHeader ? rows.slice(1) : rows;
  state.master.clear();

  source.forEach((row) => {
    const empNo = String(useHeader ? row[idxNo] : row[0] || "").trim();
    if (!empNo) return;
    const name = String(useHeader ? row[idxName] : row[1] || "").trim() || "Unknown";
    const gender = String(useHeader ? row[idxGender] : row[2] || "").trim() || "Unknown";
    state.master.set(empNo, { empNo, name, gender });
  });

  setStatus(`Master database loaded: ${state.master.size} employees.`, "ok");
  render();
}

function setStatus(text, level = "ok") {
  el.status.textContent = text;
  el.status.className = `status ${level}`;
}

function normalizeEmpNo(raw) {
  return String(raw || "").replace(/[^0-9A-Za-z]/g, "").trim();
}

function addEvent(event) {
  if (event.id && state.eventIds.has(event.id)) return;
  if (event.id) state.eventIds.add(event.id);
  state.events.unshift(event);
  if (state.events.length > 1500) state.events.length = 1500;

  if (!event.isDuplicate) state.registeredSet.add(event.empNo);
  render();
}

async function processScan(rawValue) {
  const empNo = normalizeEmpNo(rawValue);
  if (!empNo) return;

  const found = state.master.get(empNo);
  const baseEvent = {
    id: crypto.randomUUID(),
    empNo,
    name: found?.name || "Not in master database",
    gender: found?.gender || "Unknown",
    station: state.stationName,
    scannedAt: new Date().toISOString(),
    isInMaster: Boolean(found),
    isDuplicate: false
  };

  if (state.supabase) {
    try {
      const firstInsert = await state.supabase.from("registrations").insert({
        emp_no: empNo,
        emp_name: baseEvent.name,
        gender: baseEvent.gender,
        first_scanned_at: baseEvent.scannedAt,
        first_station: baseEvent.station,
        is_in_master: baseEvent.isInMaster
      });

      if (firstInsert.error && firstInsert.error.code === "23505") {
        baseEvent.isDuplicate = true;
      } else if (firstInsert.error) {
        throw firstInsert.error;
      }

      const insertedEvent = await state.supabase
        .from("scan_events")
        .insert({
          emp_no: baseEvent.empNo,
          emp_name: baseEvent.name,
          gender: baseEvent.gender,
          station: baseEvent.station,
          scanned_at: baseEvent.scannedAt,
          is_in_master: baseEvent.isInMaster,
          is_duplicate: baseEvent.isDuplicate
        })
        .select()
        .single();

      if (insertedEvent.error) throw insertedEvent.error;
      addEvent({
        id: insertedEvent.data.id,
        empNo: insertedEvent.data.emp_no,
        name: insertedEvent.data.emp_name,
        gender: insertedEvent.data.gender,
        station: insertedEvent.data.station,
        scannedAt: insertedEvent.data.scanned_at,
        isInMaster: insertedEvent.data.is_in_master,
        isDuplicate: insertedEvent.data.is_duplicate
      });
      return;
    } catch (error) {
      setStatus(`Realtime error: ${error.message}. Switched to local event save.`, "warn");
    }
  }

  baseEvent.isDuplicate = state.registeredSet.has(baseEvent.empNo);
  addEvent(baseEvent);
}

function render() {
  const uniqueEvents = state.events.filter((e) => !e.isDuplicate);
  const validUnique = uniqueEvents.filter((e) => e.isInMaster);
  const maleCount = validUnique.filter((e) => String(e.gender).toLowerCase() === "male").length;
  const femaleCount = validUnique.filter((e) => String(e.gender).toLowerCase() === "female").length;
  const mismatchCount = state.events.filter((e) => !e.isInMaster).length;
  const duplicateCount = state.events.filter((e) => e.isDuplicate).length;
  const scannedMasterSet = new Set(validUnique.map((e) => e.empNo));
  const inactive = [...state.master.values()].filter((item) => !scannedMasterSet.has(item.empNo));

  el.stats.innerHTML = "";
  [
    ["Total Registered", validUnique.length],
    ["Male", maleCount],
    ["Female", femaleCount],
    ["Total Scans", state.events.length],
    ["Duplicates", duplicateCount],
    ["Mismatches", mismatchCount],
    ["Inactive", inactive.length]
  ].forEach(([label, value]) => {
    const card = document.createElement("div");
    card.className = "stat";
    card.innerHTML = `<h3>${label}</h3><p>${value}</p>`;
    el.stats.appendChild(card);
  });

  el.scanTableBody.innerHTML = "";
  state.events.forEach((e) => {
    const row = document.createElement("tr");
    const status = e.isDuplicate ? "Duplicate" : e.isInMaster ? "Valid" : "Mismatch";
    const statusClass = e.isDuplicate ? "warn" : e.isInMaster ? "ok" : "bad";
    [
      new Date(e.scannedAt).toLocaleString(),
      e.station,
      e.empNo,
      e.name,
      e.gender
    ].forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });
    const statusCell = document.createElement("td");
    statusCell.className = statusClass;
    statusCell.textContent = status;
    row.appendChild(statusCell);
    el.scanTableBody.appendChild(row);
  });

  el.inactiveTableBody.innerHTML = "";
  inactive.slice(0, 500).forEach((e) => {
    const row = document.createElement("tr");
    [e.empNo, e.name, e.gender].forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });
    el.inactiveTableBody.appendChild(row);
  });
}

async function connectRealtime() {
  const url = el.supabaseUrl.value.trim();
  const key = el.supabaseKey.value.trim();
  if (!url || !key) {
    setStatus("Enter Supabase URL and anon key to enable shared realtime mode.", "warn");
    return;
  }

  state.supabase = window.supabase.createClient(url, key);
  localStorage.setItem("supabaseUrl", url);
  localStorage.setItem("supabaseKey", key);

  const registrationRows = await state.supabase.from("registrations").select("emp_no");
  if (registrationRows.error) {
    setStatus(`Connection failed: ${registrationRows.error.message}`, "bad");
    return;
  }

  state.registeredSet = new Set(registrationRows.data.map((r) => r.emp_no));

  const eventRows = await state.supabase
    .from("scan_events")
    .select("id, emp_no, emp_name, gender, station, scanned_at, is_in_master, is_duplicate")
    .order("scanned_at", { ascending: false })
    .limit(800);

  if (eventRows.error) {
    setStatus(`Connected, but could not load events: ${eventRows.error.message}`, "warn");
  } else {
    state.events = [];
    state.eventIds = new Set();
    eventRows.data.forEach((row) => {
      addEvent({
        id: row.id,
        empNo: row.emp_no,
        name: row.emp_name,
        gender: row.gender,
        station: row.station,
        scannedAt: row.scanned_at,
        isInMaster: row.is_in_master,
        isDuplicate: row.is_duplicate
      });
    });
  }

  state.subscription?.unsubscribe();
  state.subscription = state.supabase
    .channel("scan-events-live")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "scan_events" }, (payload) => {
      const row = payload.new;
      addEvent({
        id: row.id,
        empNo: row.emp_no,
        name: row.emp_name,
        gender: row.gender,
        station: row.station,
        scannedAt: row.scanned_at,
        isInMaster: row.is_in_master,
        isDuplicate: row.is_duplicate
      });
    })
    .subscribe();

  setStatus("Realtime shared mode connected. All stations now sync live.", "ok");
}

function wireEvents() {
  el.stationName.value = state.stationName;
  el.supabaseUrl.value = localStorage.getItem("supabaseUrl") || "";
  el.supabaseKey.value = localStorage.getItem("supabaseKey") || "";

  el.stationName.addEventListener("change", () => {
    state.stationName = el.stationName.value.trim() || state.stationName;
    localStorage.setItem("stationName", state.stationName);
  });

  el.masterCsv.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    loadMasterFromRows(parseCsv(text));
  });

  el.connectRealtime.addEventListener("click", connectRealtime);

  el.scanInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const value = el.scanInput.value;
    el.scanInput.value = "";
    await processScan(value);
  });
}

bootstrapMaster();
wireEvents();
render();
el.scanInput.focus();
