Read PROMPT.md first and follow its rules. Do Stage (c) only.
Keep the existing design of all current screens. Do not remove or
restyle anything outside what is listed here.

Staff pages (login required, Admin and Staff). Match the design images.

1. Ticket queue (/staff/tickets) from design/04-ticket-queue.png.
   - Search box (ticket number, hospital, summary).
   - Filter buttons: All, Pending, Approved, In Progress, Waiting for
     parts, Resolved. (Use these exact statuses everywhere.)
   - Table columns: Ticket, Details (issue summary), Hospital, Priority,
     Status, Submitted. Hospital column must be filled.
   - Colored status text like the design. Click a row to open the ticket.
   - New tickets show as Pending, newest first.
   - Priority: Urgent, High, Medium, Low. New public tickets default to
     Medium. Admin can change it in the ticket detail.

2. Ticket detail (/staff/tickets/:ticketNumber) from design/05, 06, 07.
   - Title: "Ticket-XXXXXX | issue summary", created date and time.
   - Details card rows: Submitted By ("Hospital employee"), Hospital,
     Problem (full details). Do NOT show a device or "Ticket Number" row.
   - History card: time + message, newest last.
   - Pending state (05): page greyed out, an "Approve" button at the top
     right. Status, Assigned To, Note, Save Update are disabled.
   - Only Admin can Approve. Staff can view but cannot approve.
   - After Approve (06): status becomes Approved, history gets
     "Approved by <name>", and the Update panel is enabled: Status
     dropdown, Assigned To dropdown (Staff users only), Note, Save Update.
   - Save Update (07): saves status, technician, and note. Assigning a
     technician sets status to In Progress automatically (note under the
     button says so). Every change adds a history row with time, who did
     it, and the note. Notes are visible to staff only.
   - Optional "Public message" field: if filled, it appears on the public
     status page. Notes stay private.
   - Resolved tickets can only be edited by Admin (reopen).

3. Notification bell: red count of Pending tickets (Admin) or tickets
   assigned to the logged-in Staff. Click opens a small list linking to
   the tickets.

4. Update the public status page tracker and history to follow the new
   statuses. Keep its current design.

5. Seed 2 extra Staff users (technicians) and 5 sample tickets with
   different statuses, using real hospital names. No PC or printer data.

Do not build the dashboard, PMS, reports, or accounts pages.
Do not start or stop the server. Stop when done and tell me the
commands to check.
