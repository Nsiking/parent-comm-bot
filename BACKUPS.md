# Automatic backups (Cloudflare R2)

Every night the database is copied, checked, compressed, **locked with your passphrase**, and saved in a Cloudflare R2
bucket, away from the server. If the server or its disk is ever lost, the school's data is not.

This works the same way in **School Management, Report Cards, the Parent Bot** (and Class Register has its own
version). All of them can share **one bucket**: each saves into its own folder (`school-management-backups/`,
`report-cards-backups/`, `parent-bot-backups/`).

## One-time setup in Cloudflare (about 10 minutes)
1. Sign in at **dash.cloudflare.com** and open **R2 Object Storage** in the left menu. (R2 asks for a payment card to switch on. It stays free up to 10 GB, and your databases are far smaller than that.)
2. Click **Create bucket**. Name it `smartclass-backups` (or anything you like, but remember it). Leave the rest as it is.
3. On the R2 page, click **Manage R2 API Tokens**, then **Create API token**.
   - Name: `smartclass-backups`
   - Permission: **Object Read & Write**
   - Apply to: **specific bucket only**, and choose your bucket
   - Click **Create API token**.
4. Copy the three values it shows (the secret is shown only once):
   - **Access Key ID**
   - **Secret Access Key**
   - the **endpoint**: `https://<your-account-id>.r2.cloudflarestorage.com`
5. **Choose a passphrase** (a long sentence only you know, for example `green bicycles argue quietly at dawn 2026`). It locks every backup. **Write it down and keep a copy somewhere safe and offline. If it is lost, the backups cannot be opened by anyone, including us.**

## On Render (once for each of the three services)
Open the service, click **Environment**, and add these five settings (click **Add Environment Variable** for each), then **Save Changes**:

| Name | Value |
|---|---|
| `BACKUP_S3_ENDPOINT` | `https://<your-account-id>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET` | your bucket name, for example `smartclass-backups` |
| `BACKUP_S3_ACCESS_KEY_ID` | the Access Key ID |
| `BACKUP_S3_SECRET_ACCESS_KEY` | the Secret Access Key |
| `BACKUP_ENCRYPTION_KEY` | your passphrase |

Render restarts the service. Within about two minutes the first backup is made by itself. Then every night at 02:00 (Lagos time).

## Check that it works
- **School Management** and **Report Cards**: sign in as the **platform administrator**. The **Automatic backups** card is on the Schools page.
- **Parent Bot**: sign in as the **owner** (the first administrator account). The card is on the Settings page.
- It should say **Working** and **Locked with your passphrase**, with the time of the last backup. Click **Back up now** to make one straight away.
- You can also open the bucket in Cloudflare and see the files.

## What is kept
Everything from the last 2 days, then one a day for 14 days, one a week for 8 weeks, one a month for 12 months. Older ones are removed automatically. You can change this with `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`, `BACKUP_KEEP_MONTHLY`, and the hour with `BACKUP_HOUR` (default 2).

## If you ever need to restore (practise once on a quiet day)
You need the **Starter** plan or higher on Render (it includes Shell).
1. On Render open the service and click **Shell**.
2. Type `node restore-backup.js list` and press Enter. You see the backups, newest first.
3. Type `node restore-backup.js stage latest` (or `stage` and the name of an older one). It downloads the backup, unlocks it with your passphrase, and checks it. **Nothing has changed yet.**
4. Restart the service: **Manual Deploy**, then **Restart service**. As it starts, the backup is put in place.
5. The database that was there before is kept next to it, named `...before-restore-<date>`, so nothing is thrown away.

## Good to know
- **What a backup holds:** the whole database (all schools, pupils, fees, results, messages and settings), including school logos.
- **What it does not hold:** the small secret file that locks the School Management key inside Report Cards and the Parent Bot. If the disk is ever lost and you restore onto a new one, the Head Teacher or administrator just clicks **Connect** again in Settings and pastes the key.
- **Costs:** the bucket stays inside Cloudflare's free tier for databases of this size.
- **Nothing is sent anywhere** until the `BACKUP_S3_*` settings exist.

## If the card shows a red message
| It says | Do this |
|---|---|
| The bucket did not accept the secret key | Re-paste `BACKUP_S3_SECRET_ACCESS_KEY` with no spaces. If unsure, create a new API token. |
| The bucket does not recognise the access key | Re-paste `BACKUP_S3_ACCESS_KEY_ID`. |
| The bucket was not found | `BACKUP_S3_BUCKET` must be exactly the bucket's name. |
| The API token is not allowed to use this bucket | Make the token **Object Read & Write** for this bucket. |
| Could not reach the bucket | Check `BACKUP_S3_ENDPOINT` starts with `https://` and has your account id, with nothing after `.com`. |
| Last backup was N hours ago (red) | Click **Back up now** and read the message. |
