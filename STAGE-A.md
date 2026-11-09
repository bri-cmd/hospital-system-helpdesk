Read PROMPT.md first and follow its rules. Do Stage (a) only.

1. Create the project in this folder: package.json, src/, .env.example.
   .gitignore already exists.
2. `npm run db:migrate` creates the database tables, and `npm run db:seed`
   adds sample data. Tables for now: users (admin/staff), hospitals,
   tickets, ticket_history. Leave PMS tables for stage (e).
3. Login page (username + password, same style and colors as the design).
   Roles: Admin and Staff. Passwords hashed. Admin account created by
   seed, password read from .env, not hardcoded.
4. Layout shell from 03-dashboard.png: logo, "Hospital Systems Helpdesk",
   sidebar (Dashboard, Ticket queue, Monitoring, Reports), top bar with
   bell, user name, role badge. Pages can be empty placeholders.
5. Only logged-in users can open the staff pages.
6. Public landing page at "/" from 00-main-page.png: full-screen plant
   photo background with a light white overlay, logo, the title
   "Welcome to BMC HOSPITAL SYSTEM HELPDESK", and two buttons: "Open a New
   Ticket" (blue) and "Check Ticket Status" (green). Buttons can link to
   placeholder pages for now. Add a small "Sign in" link at the top right
   that goes to the staff login.

Do not build the ticket form, queue, dashboard, or PMS yet.
Stop when done and tell me the 3 commands I should run to check.
