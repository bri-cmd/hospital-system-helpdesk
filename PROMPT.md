# Working rules (follow every stage)

- Do NOT start or stop servers. I run them myself.
- Do NOT write long test scripts. Keep checks short.
- If a check fails twice, STOP and tell me what failed.
- Do NOT change any screen or behavior this prompt does not mention.
- Never ask me to paste SQL into Workbench. Use `npm run db:migrate`.
- Never read, print, or commit `.env`. Keep `.env.example` with placeholders.
- Keep each stage small. Stop at the end of the stage and wait.
- Keep the existing design of every screen. Never remove elements (header, logo, icons, text) from a page unless the prompt says so. "Only show X" means do not add extra things, not remove the layout.

# Project
- Name: Hospital Systems (HS) Helpdesk
- Company: Brilliant Metal Craft and Machine Design OPC
- Department: Hospital Systems (NOT IT)
- Purpose: Ticketing for problems at hospital oxygen/air plants, plus
  PMS (preventive maintenance schedule) monitoring across 18 hospitals.
- Stack: Node.js + MySQL. Own code, own port, own database, own DB user.
  Nothing shared with the IT helpdesk.
- Port: 3001. Database: hs_helpdesk.
- Header text: "Hospital Systems Helpdesk" (never "IT Service Desk").
- Design: /design folder, numbered in screen order (00 to 10). Follow the
  images. 00-main-page.png is the public landing page. The plant photo
  goes in /public/images/plant.jpg (use a plain gradient if missing).
  Do NOT copy these design mistakes: "Ticket Number" row showing a device,
  "Hospital: Hardware", PC/printer sample data.

# Login (decided)
- Only Admin and Staff (technician) log in.
- Hospital employees open tickets WITHOUT login and check status by
  ticket number. (TBD: employee login, do not build yet.)

# Ticket flow
Pending (greyed out, waits for admin) -> Admin clicks Approve -> Approved
-> admin assigns technician -> In Progress -> Waiting for parts -> Resolved.
- Before approval: Status, Assigned To, Note, Save Update are disabled.
- Every change is recorded in the ticket History with time and who did it.
- Assigning a technician sets status to In Progress automatically.

# PMS rules
- Item status, from "Next PMS" date vs today:
  - Overdue: Next PMS is before today
  - Expiring soon: due within 30 days
  - Preparing: due after 30 days
  - For update: no Next PMS date yet
- Hospital "On schedule %" = Preparing items / total items x 100.
- Next PMS = last done date + frequency (6, 12, 24, 60 months).

# Stages
(a) Setup, database, `npm run db:migrate`, seed, admin/staff login, layout shell, main page
(b) Public: open ticket form, request sent, check ticket status
(c) Ticket queue + ticket detail (approval flow, history, notification bell)
(d) Dashboard
(e) PMS monitoring (hospitals list, hospital detail, import of PMS data)
(f) Reports and Accounts
(g) Machines page (only if the dept head wants it)

