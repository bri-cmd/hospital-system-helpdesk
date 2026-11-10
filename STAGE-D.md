Read PROMPT.md first and follow its rules. Do Stage (d) only.
Keep the existing design of all current screens. Do not remove or
restyle anything outside what is listed here.

Staff Dashboard (/staff/dashboard) from design/03-dashboard.png.
Header and sidebar stay as they are. Title "Dashboard". Do NOT copy
the "Sample data for design review" text, and do not show any PC or
printer data.

1. Four summary cards:
   - Open Tickets: tickets not Resolved (Pending, Approved,
     In Progress, Waiting for parts).
   - For Approval: tickets with status Pending (red number).
   - PMS due this week: show 0 for now with the label unchanged.
     It will be connected in Stage (e).
   - Devices on schedule: show "--" for now. It will be connected
     to the PMS "On schedule %" in Stage (e).
   Clicking Open Tickets or For Approval opens the ticket queue with
   that filter applied.

2. "Recent tickets" panel: latest 5 tickets (ticket number, issue
   summary, hospital, and a colored status badge like the design:
   Pending orange, Approved green, others matching the queue). Each row
   links to the ticket detail. Add a "View queue" link.

3. "PMS Monitoring" panel: keep the panel and title, with the message
   "PMS data will appear here" for now. Add a "View monitoring" link to
   /staff/monitoring.

4. Staff users see the same dashboard, but the numbers only count
   tickets assigned to them. Admin sees all.

5. Make "Dashboard" in the sidebar open this page after login.

Do not build the PMS pages, reports, or accounts. Do not start or stop
the server. Stop when done and tell me the commands to check.
