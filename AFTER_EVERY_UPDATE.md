# After every update: keep the School Management connection

Your product works on its own AND with School Management because a few small lines in `server.js`,
`public/app.js` and `public/index.html` load the connection. If an update replaces one of those files with a
copy that does not have the lines (for example, a copy made before the connection was added), the product still
works on its own, but the **Open** button in School Management stops working.

## The routine (30 seconds)
In the product's own black window, in its own folder, BEFORE you commit:

    node apply-sm-connection.js

- "already installed": nothing to do. Commit as usual.
- "Done ... only the missing parts were added": the connection was lost and is back. Nothing of yours was replaced. Commit.
- "NOTHING WAS CHANGED" and a sentence: your update changed a spot the installer needs. Send the sentence.

Never use `--undo` to fix this: it goes back to the files as they were before the connection, which throws your update away.

## The Parent Bot only: backups too
    node apply-backup.js

## Quick check after you upload
In School Management click Products, then Open next to the product. It should sign you in.
