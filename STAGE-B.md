Read PROMPT.md first and follow its rules. Do Stage (b) only.

Public pages, NO login needed. Match the design images.

1. "Open a New Ticket" page (/tickets/new) from design/01-ticket-form.png.
   Header: logo + "Brilliant Metal Craft and Machine Design OPC", small
   "Sign in" link at the top right. Fields:
   - Issue Summary (required)
   - Hospital (required dropdown, loaded from the hospitals table)
   - Details (required textarea)
   Buttons: "Create Ticket" and "Cancel" (Cancel goes back to "/").
   Show validation messages. Create Ticket is disabled until required
   fields are filled.
2. Saving creates a ticket with status Pending, a unique 6-digit ticket
   number, the hospital, summary, details, created time, and the first
   ticket_history row ("Ticket created by employee (Self-service)").
3. "Request sent" page from design/02-ticket-submitted.png: green check,
   "Your ticket number is XXXXXX. Admin will look at it soon." and a
   button "Check ticket status" that opens the status page with the
   ticket number filled in. Remove the "Maria Santos - Sign out" text
   (no employee login).
4. "Check Ticket Status" page (/tickets/status): input for ticket number
   and a button. Shows: summary, ticket number, submitted date, hospital,
   current status as a progress tracker (Pending, Approved, In Progress,
   Resolved), assigned technician ("Not assigned yet" if none), last
   update time, and the History list (time + short message). Do NOT show
   internal technician notes, only status changes and a public message.
   Show a friendly message if the ticket number is not found.
5. Wire the two landing page buttons to these pages.
6. Seed the hospitals table with the 18 hospitals from
   design/08-pms-monitoring.png (RTR, SUMC, CUMC, Tagum Medical City,
   Ciudad de Zamboanga, PMMG-PPC Hospital, Tagum Doctors Hospital,
   Adventist Medical Center - Valencia, Gatchalian Medical Center,
   San Isidro Polymedic General Hospital, Visayas Med, Negros Polymedic
   Hospital, Brokenshire Medical Center, Cauayan Medical Specialist
   Hospital, Surigao DOC, Caraga Regional Hospital (O1),
   Caraga Regional Hospital (O2), Mactan Medical). Update
   `npm run db:seed` and `npm run db:migrate` if the schema changes.
7. Add basic protection: limit ticket submissions per IP (for example
   10 per hour) and escape all user text.

Do not build the staff ticket queue, ticket detail, dashboard, or PMS.
Do not start or stop the server. Stop when done and tell me the
commands to check.
