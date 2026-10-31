# MongoDB setup for Classic Mart

Classic Mart does not require Docker. It requires a MongoDB deployment that supports multi-document transactions. MongoDB Atlas remains a supported option, especially for shared/remote development. For local Windows development, v2.8.13 can instead bootstrap Classic Mart's own isolated MongoDB replica set automatically, so Atlas credentials are not required.

## 1. Create or choose a cluster

Create a MongoDB Atlas cluster or use another managed/self-hosted MongoDB replica set/mongos deployment.

## 2. Create an application database user

Create a database user for Classic Mart. Use a strong generated password and grant only the database permissions needed by the application. For the development release gate, the user must also be able to create/drop `classic-mart-audit-test`, or you must provide a separate `AUDIT_MONGO_URI` with those permissions. URL-encode special characters when placing the username/password inside a connection string.

## 3. Allow the development machine

Configure the database network-access policy so the machine running Classic Mart can connect. Avoid broad public access for production.

## 4. Configure `.env`

Copy `.env.example` to `.env`, then set:

```env
MONGO_URI=mongodb+srv://USERNAME:PASSWORD@CLUSTER_HOST/classic-mart?retryWrites=true&w=majority
AUDIT_MONGO_URI=
REDIS_URL=
```

`AUDIT_MONGO_URI` can remain blank. The release audit derives the same cluster URI with the database name `classic-mart-audit-test` and guards the destructive reset by requiring the `audit-test` suffix.

If you prefer a separate audit cluster/user, set `AUDIT_MONGO_URI` explicitly to a database name ending in `audit-test`.

## 5. Verify before seeding

```bash
npm ci
npm run db:verify
```

Expected result resembles:

```text
MongoDB transaction topology ready — replicaSet=...
```

Then run:

```bash
npm run verify:local
npm run dev
```

## Redis

Redis is optional. Leave `REDIS_URL=` blank to use MongoDB-backed sessions. A managed Redis service can be configured later for higher session/cache throughput without changing the business workflows.
