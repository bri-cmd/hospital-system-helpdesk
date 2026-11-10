Read PROMPT.md first and follow its rules. Do Stage (f) only.
Keep the existing design of all current screens. Do not remove or
restyle anything outside what is listed here. Hospital Systems has no
devices: never add device, machine, PC, printer or help-topic content.
Reuse the layout and card style of the Dashboard and Monitoring pages.

1. Reports page (/staff/reports), Admin and Staff can view.
   - Filters: Period (month picker, default current month) and Hospital
     (All hospitals or one).
   - Cards: Tickets received, Tickets resolved, Pending approval,
     Average time to resolve (created to Resolved, shown as "X hr Y min"
     or "N days"), PMS on schedule % (Preparing / total items x 100,
     for the selected hospital or all).
   - "Tickets by hospital": horizontal bars with counts, highest first.
   - "Tickets by status": Pending, Approved, In Progress, Waiting for
     parts, Resolved.
   - "Tickets by priority": Urgent, High, Medium, Low.
   - "PMS status by hospital": table with Overdue, Expiring soon,
     For update, On schedule % per hospital.
   - Admin only buttons: "Export tickets (CSV)" for the selected period
     and hospital, and "Export PMS (CSV)" with all PMS items and their
     computed status. CSV must open correctly in Excel (UTF-8 BOM).
   - Staff users only count tickets assigned to them.

2. Accounts page (/staff/accounts), Admin only. Add "Accounts" to the
   sidebar for Admin only.
   - Table: Name, Username, Role badge, Status (Active/Disabled), Last
     sign-in, Actions.
   - "+ Add account": name, username, role, temporary password.
     Username unique. Password min 8 characters, hashed.
   - Actions: Edit (name, role), Reset password, Disable / Enable.
   - The main admin cannot be disabled or demoted. An admin cannot
     disable their own account.
   - Disabled users cannot sign in (clear message), history stays.
     Record last_sign_in on every successful login.
   - Every account change is logged (who, when, what).
   - Only Active Staff appear in the "Assigned To" dropdown.

Do not build a Machines or Equipment page. Do not change tickets or PMS
logic. Do not start or stop the server. Stop when done and tell me the
commands to check.
