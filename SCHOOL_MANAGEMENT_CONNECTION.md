# Parent Bot + School Management

This connects the Parent Communication Bot to SmartClass School Management. A school that does not connect is
not affected in any way. **Nothing here ever sends a message by itself:** everything creates drafts that staff
review and send, exactly like the Bot's own Compose screen.

## What it adds
- **Import parents** (Parents page): brings every active pupil and their main parent's name and phone number from School Management. Details are refreshed on every import; the channel you chose and any opt-outs are kept.
- **Fee reminders** (Compose page): drafts one reminder for every family that owes fees, with the **real amount** from School Management (this term, and anything owed from earlier terms). "Check who owes" shows the numbers first. Pick a term, a class, a minimum amount, a tone and a language, and add your own words (for example where to pay).
- **Absence alerts** (Compose page): drafts an alert for every pupil School Management has marked absent for the whole day (or late). Pupils already alerted that day, including by the Class Register hook, are skipped.
- **Delivery notes:** each message that reaches a pupil's parent is noted once on that pupil's page in School Management (kind, channel, status), within a few minutes.
- **Single sign-on:** the **Open** button in School Management signs existing Parent Bot staff straight in. It never creates an account.

## How a school connects (the administrator, once)
1. In **School Management**: Settings, Connected products, Connect a product, choose **Parent Bot**. Web address: your Parent Bot address (keep the sign-in path `/sso`). Copy the key. (If this connection existed before, open Edit and tick **Read fee balances**.)
2. In the **Parent Bot**: Settings, find **SmartClass School Management**, paste the web address of School Management and the key, click **Connect**.
3. On the Parents page click **Import parents from School Management**.

## Rules that make it work
- A pupil is reached only if their main parent has a **valid phone number** in School Management. The import lists the pupils that have none.
- Pupils are matched by **admission number** (parents you added earlier by hand are matched, not duplicated).
- The same family is never reminded twice on the same day.

## Safety
- The fee amount in every reminder is checked against School Management. If the AI wording leaves the amount out or changes it, the built-in wording is used instead.
- If AI drafting is on, the child's first name, class, the parent's name and the amount owed are sent to the AI provider (as for any fees reminder). Untick **Word with AI** on the Compose card to keep a reminder entirely on your own server.
- The School Management key is stored **encrypted**, and never sent to the browser. The secret that locks it is kept in a small file next to the database (or in `SM_KEY_SECRET` if you set it).
- If the connection ever failed to start, the Parent Bot would carry on exactly as before and only write the reason in its log.

## Put it back
`node apply-sm-connection.js --undo` restores the three changed files exactly (the originals are in the `sm-backup-...` folder).
