Read PROMPT.md first and follow its rules. Do Stage (g) only.
Keep the existing design of all current screens. Do not remove or
restyle anything outside what is listed here.

This replaces the IT "Machines" page. Hospital Systems tracks plant
EQUIPMENT per hospital (compressors, air treatment, receivers, gauges).
Never add PC, printer, RAM, motherboard or department content. Use the
layout style of design/10-machines.png only (title, subtitle, tabs,
table, blue add button), not its content.

1. Database (update `npm run db:migrate`): table equipment with
   hospital_id, name (e.g. Compressor #1), type (Air Treatment,
   Compressor, Receiver, Analyzer, Gauge, Other), model, serial_number,
   installed_date (nullable), status (Operational, Under repair,
   Decommissioned), notes. Add nullable equipment_id to pms_items and
   to tickets.

2. Sidebar: add "Equipment" between "Ticket queue" and "Monitoring".

3. Equipment page (/staff/equipment):
   - Title "Equipment", subtitle "Plant equipment per hospital, with
     model, serial number, and status."
   - Hospital filter dropdown, type tabs (All, Air Treatment,
     Compressor, Receiver, Analyzer, Gauge), and a search box.
   - Table: Hospital, Equipment, Type, Model, Serial number, Status
     badge (green Operational, orange Under repair, gray
     Decommissioned), and a "View details" link.
   - "+ Add equipment" button (Admin only) with a form for all fields.

4. Equipment detail (/staff/equipment/:id): "Back to equipment" link,
   name and hospital, specs card, "PMS items" card (items linked to
   this equipment with Next PMS and status badge), and "Linked tickets"
   card (ticket number, summary, status). Admin can Edit specs and
   change status. Log every change (who, when, old and new values).

5. Public ticket form: after choosing a Hospital, show an optional
   "Equipment" dropdown with that hospital's equipment (load it with a
   small JSON endpoint). "Not sure / not listed" is allowed. Show the
   Equipment row on the staff ticket detail only if one was chosen,
   linking to the equipment page.

6. Seed (mark as sample data in the seed file only): for Gatchalian
   Medical Center create Air Treatment, Compressor #1 (COMP AIR-L18-75A),
   Compressor #2, and Calibration & Other (pressure gauges, analyzers),
   and link its existing PMS items to them by group name. Add 2 to 3
   items for SUMC, RTR and Mactan Medical.

Do not change ticket approval, PMS logic, reports, or accounts.
Do not start or stop the server. Stop when done and tell me the
commands to check.
