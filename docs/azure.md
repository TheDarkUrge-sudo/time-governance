# Running on Azure

The worker runs as **one always-on container** in Azure Container Apps, with
**Azure Database for PostgreSQL** for its data. Staff time and performance
data then stays inside the firm's own Microsoft tenant. Admin commands
(roster upload, history, dry runs) run from a laptop in VS Code against the
same database — see [Running admin commands from VS Code](#running-admin-commands-from-vs-code).

Why one always-on container rather than Container Apps scheduled jobs: Azure's
job schedules run in UTC, so "Tuesday 9:00 Eastern" would drift an hour at each
daylight-saving change. The worker's own scheduler runs in `FIRM_TIMEZONE`
and also applies the "first Monday on or after the 8th" rule.

**Rough cost:** about $35–45/month — PostgreSQL Burstable B1ms with 32 GB,
one 0.25 vCPU / 0.5 GiB container running all month, a Basic container
registry, and a little Log Analytics. Check the
[Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/)
for your region and agreement.

These steps were written against the current Azure CLI but have not been run
in the firm's tenant — have IT review them before running.

## 1. One-time setup

Run from the repository root (Azure Cloud Shell works; nothing needs Docker
locally — the image is built in Azure).

```sh
# Names — the registry and database server names must be globally unique.
RG=rg-time-governance
LOC=eastus
ACR=hfatimegov$RANDOM
PG=hfa-timegov-pg-$RANDOM
PG_ADMIN=tgadmin
PG_PASSWORD='<a long random password>'
ENVNAME=cae-time-governance
APP=time-governance

az login
az extension add --name containerapp --upgrade
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights

az group create --name $RG --location $LOC
```

### Database

```sh
az postgres flexible-server create \
  --resource-group $RG --name $PG --location $LOC \
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
  --admin-user $PG_ADMIN --admin-password "$PG_PASSWORD" \
  --backup-retention 35 \
  --public-access 0.0.0.0

az postgres flexible-server db create \
  --resource-group $RG --server-name $PG --database-name timegov
```

`--public-access 0.0.0.0` allows connections from Azure services (the
container) only; TLS and the password still apply. To run admin commands from
a laptop, also allow that machine's public IP:

```sh
az postgres flexible-server firewall-rule create \
  --resource-group $RG --name $PG --rule-name admin-laptop \
  --start-ip-address <ip> --end-ip-address <ip>
```

The connection string the app uses (URL-encode the password if it has
special characters):

```sh
DATABASE_URL="postgres://$PG_ADMIN:$PG_PASSWORD@$PG.postgres.database.azure.com:5432/timegov?sslmode=require"
```

### Image

```sh
az acr create --resource-group $RG --name $ACR --sku Basic
az acr build --registry $ACR --image time-governance:1 .
```

### Worker

```sh
az containerapp env create --resource-group $RG --name $ENVNAME --location $LOC

az containerapp create \
  --resource-group $RG --name $APP --environment $ENVNAME \
  --image $ACR.azurecr.io/time-governance:1 \
  --registry-server $ACR.azurecr.io --registry-identity system \
  --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
  --secrets \
    database-url="$DATABASE_URL" \
    karbon-key='<KARBON_API_KEY>' \
    karbon-secret='<KARBON_API_SECRET>' \
    sendgrid-key='<SENDGRID_API_KEY>' \
  --env-vars \
    DATABASE_URL=secretref:database-url \
    KARBON_API_KEY=secretref:karbon-key \
    KARBON_API_SECRET=secretref:karbon-secret \
    SENDGRID_API_KEY=secretref:sendgrid-key \
    SENDGRID_FROM_EMAIL='<from address>' \
    TG_MODE=shadow \
    TG_SHADOW_TO='<COO email>' \
    TG_ADMIN_TO='<admin email>' \
    FIRM_TIMEZONE=America/New_York
# Karbon governance notes (optional, later): add
#   TG_KARBON_NOTES=shadow KARBON_NOTE_AUTHOR='<karbon user>' KARBON_NOTES_SHADOW_CLIENT_ID='<id>'
# with `az containerapp update --set-env-vars …`.
```

No ingress: the worker serves nothing. On start it applies any new
migrations, then runs the schedules. Keep `--max-replicas 1` — two copies
would both fire each schedule (sends are claimed once, so nothing would
double-send, but it is wasted work).

Check it started:

```sh
az containerapp logs show --resource-group $RG --name $APP --follow
# → "Migrations applied." then "time governance worker started — Tue 9:00, …"
```

## 2. Day to day

**Ship a new version** (bump the tag each time):

```sh
az acr build --registry $ACR --image time-governance:2 .
az containerapp update --resource-group $RG --name $APP \
  --image $ACR.azurecr.io/time-governance:2
```

**Change a setting** (e.g. go live after the shadow trial):

```sh
az containerapp update --resource-group $RG --name $APP --set-env-vars TG_MODE=live
```

**Change a secret:** `az containerapp secret set … --secrets karbon-key='<new>'`,
then restart: `az containerapp revision restart --resource-group $RG --name $APP --revision <name>`
(`az containerapp revision list` shows the name).

**Run a command inside the container** (status, a manual run):

```sh
az containerapp exec --resource-group $RG --name $APP --command "pnpm tg status"
az containerapp exec --resource-group $RG --name $APP --command "pnpm tg run tuesday"
```

Commands that need a file (the roster upload) or produce one (the history
export) are easier from a laptop — next section.

## Running admin commands from VS Code

A laptop is not a host — it can't be relied on to be on at 9:00 every
Tuesday — but it is the easiest place to upload the roster, look up history
and do dry runs.

1. Install [Node.js 24](https://nodejs.org), Git and VS Code. Then
   `corepack enable` (provides pnpm at the version the repo pins).
2. Clone the repo, open it in VS Code (accept the recommended extensions),
   and run `pnpm install`.
3. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — the Azure connection string above (and add the
     laptop's IP to the database firewall).
   - `KARBON_API_KEY` / `KARBON_API_SECRET` — for roster matching and dry runs.
   - **`TG_MODE=off`** — so nothing run from the laptop ever sends email. The
     Azure worker is the only thing that should send. With it off, `pnpm tg run`
     only works with `--dry-run`; re-run a real job with `az containerapp exec`.
4. Then, in VS Code's terminal:

```sh
pnpm tg status
pnpm tg roster:import roster.xlsx            # preview
pnpm tg roster:import roster.xlsx --apply    # save
pnpm tg run tuesday --dry-run                # emails → out/, nothing sent or saved
pnpm tg history riley
pnpm tg history --export 2026                # → out/time-governance-history-2026.xlsx
```

`out/` holds real staff data — it is gitignored; don't copy it to shared
folders.

## Hardening (optional, for IT)

- **Private networking:** put the Container Apps environment and the database
  in a VNet with the database on private access, instead of the public
  endpoint above. Admin commands then run through `az containerapp exec` or
  from a machine on the VNet.
- **Key Vault:** reference secrets from Key Vault instead of storing them on
  the container app.
- **Entra ID database auth** in place of the password.
