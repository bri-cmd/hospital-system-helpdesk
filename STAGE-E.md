Read PROMPT.md first and follow its rules. Do Stage (e) only.
Keep the existing design of all current screens. Do not remove or
restyle anything outside what is listed here. Hospital Systems has no
devices: never add device, machine, PC or printer content.

1. Database (update `npm run db:migrate`): table pms_items with
   hospital_id, group_name (e.g. Air Treatment, Compressor #1,
   Compressor #2, Calibration & Other), item, part_number, qty (text,
   e.g. "1 PC/S", "3 BAG"), frequency_months (6, 12, 24, 60),
   last_done (date, nullable), next_pms (date, nullable), notes.
   Status is NOT stored. Compute it from next_pms vs today, per PROMPT.md:
   Overdue (before today), Expiring soon (within 30 days), Preparing
   (after 30 days), For update (no next_pms).

2. Monitoring page (/staff/monitoring) from design/08-pms-monitoring.png:
   - Title "PMS Monitoring", subtitle: "Preventive maintenance across N
     hospitals - N items - as of <today>". Use real counts and date.
   - Four cards: Preparing (green), Expiring soon (orange), Overdue
     (red), For update (black), counted across all hospitals.
   - Left panel "Hospitals": table with Hospital, Status bar (stacked
     red/orange/gray/green by proportion), Overdue, Expiring, For
     update, On schedule %. Sorted by most overdue first. Each row
     opens the hospital detail. On schedule % = Preparing / total x 100.
   - Right panels "PMS Overdue" and "PMS Expiring Soon": top 5 each,
     one entry per hospital showing item count, the most urgent item
     group, and "Overdue N days" / "Due in N days" badge.

3. Hospital detail (/staff/monitoring/:hospitalId) from
   design/09-pms-hospital.png:
   - "All hospitals" back link, hospital name, subtitle "N PMS items -
     N% on schedule - as of <today>", four status cards for this
     hospital.
   - PMS schedule table grouped by group_name with columns Item, Part
     number, Qty, Frequency (Every N mo), Next PMS, Days left, Status
     badge. Overdue shows "N days overdue" in red.
   - Filter buttons: All, Preparing, Expiring soon, Overdue, For update,
     and a search box.
   - Admin and Staff can view. Only Admin can edit an item (inline edit:
     last done date, next PMS date, notes). Setting last_done
     recalculates next_pms = last_done + frequency_months.
     Every edit is logged (who, when, old and new values).

4. Import (Admin only) at /staff/monitoring/import: upload a CSV with
   columns hospital, group, item, part_number, qty, frequency_months,
   last_done, next_pms. Show a preview and a count of rows to add
   before confirming. Unknown hospital names are listed as errors, not
   created. Provide a downloadable CSV template.

5. Seed: Gatchalian Medical Center with the 24 items from
   design/09-pms-hospital.png (same groups, item names, part numbers,
   qty, frequency, next PMS dates). Add a few items to 3 other
   hospitals so the overview is not empty. Mark this clearly as
   sample data in the seed file only.

6. Connect the Dashboard: card "PMS expiring soon", card "PMS overdue",
   and the "PMS Overdue" / "PMS Expiring Soon" panels use real counts
   and the top 3 entries. Keep the dashboard design as it is.

Do not build reports or accounts. Do not start or stop the server.
Stop when done and tell me the commands to check.
