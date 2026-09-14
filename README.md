# Employee Registration System (ATL 2026)

A colorful HTML/CSS/JS employee registration system for barcode-scanner based attendance/registration.

## Features

- Single scan field for barcode reader input (EMP_NO)
- Live table of all scans with scan time, station, employee details, and status
- Realtime counters: total, male, female, inactive, mismatches, duplicates
- CSV master database upload (`EMP_NO,EMP_NAME,Gender`)
- Inactive employee list (master records not scanned yet)
- Realtime multi-station sync support for 12+ laptops via Supabase
- Duplicate detection across all stations

## Quick start (GitHub Pages compatible)

1. Deploy this repository to GitHub Pages.
2. Open the page and upload your master CSV file.
3. Start scanning employee cards in the scan field.

## Realtime shared mode setup (for 12 stations)

To avoid clashes/missing data when multiple laptops scan simultaneously, configure Supabase:

1. Create a Supabase project.
2. Run this SQL in Supabase SQL Editor:

```sql
create table if not exists public.registrations (
  emp_no text primary key,
  emp_name text not null,
  gender text,
  first_scanned_at timestamptz not null,
  first_station text not null,
  is_in_master boolean not null default false
);

create table if not exists public.scan_events (
  id uuid primary key default gen_random_uuid(),
  emp_no text not null,
  emp_name text not null,
  gender text,
  station text not null,
  scanned_at timestamptz not null,
  is_in_master boolean not null default false,
  is_duplicate boolean not null default false
);

alter publication supabase_realtime add table public.scan_events;
```

3. In the app, open **Realtime Sync** and paste:
   - Supabase URL
   - Supabase anon key
4. Click **Connect Realtime** on each station.

Now when one station scans an employee, all stations see the same live data and duplicate status.
